// -*- Mode: js; indent-tabs-mode: nil; c-basic-offset: 4; tab-width: 4 -*-
//
// Gnome Weather is free software; you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by the
// Free Software Foundation; either version 2 of the License, or (at your
// option) any later version.
//
// Gnome Weather is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
// for more details.
//
// You should have received a copy of the GNU General Public License along
// with Gnome Weather; if not, write to the Free Software Foundation,
// Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA

// org.gnome.Weather.Forecast: lets other components (the companion GNOME
// Shell extension in shell-extension/) get a forecast from whichever
// provider the user picked in Weather, instead of libgweather's defaults.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';

import * as Util from '../misc/util.js';
import * as Providers from '../shared/providers.js';
import {WeatherInfo} from '../shared/weatherInfo.js';

const ForecastInterface = `
<node>
  <interface name="org.gnome.Weather.Forecast">
    <!-- Returns JSON: {valid, error, name, attribution, source,
         current: {time, tempC, icon}, forecast: [{time, tempC, icon}]}.
         An empty name means "name it from the coordinates". -->
    <method name="GetForecast">
      <arg type="d" name="latitude" direction="in"/>
      <arg type="d" name="longitude" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
  </interface>
</node>`;

type Point = {time: number; tempC: number; icon: string};

function point(info: WeatherInfo): Point | null {
    const [okTime, time] = info.get_value_update();
    const [okTemp, tempC] = info.get_value_temp(
        GWeather.TemperatureUnit.CENTIGRADE
    );
    if (!okTime || !okTemp || time === 0) return null;
    return {time, tempC, icon: info.get_icon_name()};
}

export class ForecastService {
    private impl: Gio.DBusExportedObject;
    private application: Gio.Application;
    private settings: Gio.Settings;

    public constructor(application: Gio.Application) {
        this.application = application;
        this.settings = Util.getSettings('org.gnome.Weather');
        this.impl = Gio.DBusExportedObject.wrapJSObject(
            ForecastInterface,
            this
        );
    }

    public export(connection: Gio.DBusConnection, path: string): void {
        this.impl.export(connection, path);
    }

    public unexport(connection: Gio.DBusConnection): void {
        this.impl.unexport_from_connection(connection);
    }

    public GetForecastAsync(
        params: [number, number, string],
        invocation: Gio.DBusMethodInvocation
    ): void {
        const [latitude, longitude, requestedName] = params;
        this.application.hold();

        this.forecast(latitude, longitude, requestedName)
            .then(json =>
                invocation.return_value(new GLib.Variant('(s)', [json]))
            )
            .catch((e: unknown) =>
                invocation.return_dbus_error(
                    'org.gnome.Weather.Error.Failed',
                    String(e)
                )
            )
            .finally(() => this.application.release());
    }

    private async forecast(
        latitude: number,
        longitude: number,
        requestedName: string
    ): Promise<string> {
        const name =
            requestedName ||
            (await Providers.reverseGeocode(latitude, longitude)) ||
            '';
        const location = GWeather.Location.new_detached(
            name,
            null,
            latitude,
            longitude
        );
        const info = Providers.buildInfo(this.settings, location);

        await new Promise<void>(resolve => {
            const id = info.connect('updated', () => {
                info.disconnect(id);
                resolve();
            });
            info.update();
        });

        const valid = info.is_valid();
        const error =
            !valid && 'getError' in info
                ? (
                      info as unknown as {getError(): string | undefined}
                  ).getError()
                : undefined;

        return JSON.stringify({
            valid,
            error: error ?? null,
            name: location.get_name(),
            attribution: info.get_attribution(),
            source: info.getForecastSource(),
            current: valid ? point(info) : null,
            forecast: valid
                ? info
                      .get_forecast_list()
                      .map(point)
                      .filter((p): p is Point => !!p)
                : [],
        });
    }
}
