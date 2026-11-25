// Weather Provider Bridge
//
// GNOME Shell's calendar-menu weather (js/misc/weather.js) fetches its own
// forecast through libgweather with hard-coded backends; it only asks the
// Weather app *where*. This extension swaps the WeatherClient's GWeather.Info
// for an object that asks the forked Weather app's background service
// (org.gnome.Weather.Forecast on org.gnome.Weather.BackgroundService), so the
// panel shows the same provider - and the same cached data - as the app.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Geoclue from 'gi://Geoclue';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.gnome.Weather.BackgroundService';
const OBJECT_PATH = '/org/gnome/Weather/BackgroundService';
const ForecastIface = `
<node>
  <interface name="org.gnome.Weather.Forecast">
    <method name="GetForecast">
      <arg type="d" name="latitude" direction="in"/>
      <arg type="d" name="longitude" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
  </interface>
</node>`;
const ForecastProxy = Gio.DBusProxy.makeProxyWrapper(ForecastIface);

function convertTemp(celsius, unit) {
    switch (GWeather.temperature_unit_to_real(unit)) {
    case GWeather.TemperatureUnit.FAHRENHEIT:
        return celsius * 9 / 5 + 32;
    case GWeather.TemperatureUnit.KELVIN:
        return celsius + 273.15;
    default:
        return celsius;
    }
}

/**
 * Title shown in the date menu. The menu shortens titles of non-city
 * locations to the nearest libgweather city when that city's name appears
 * in them ("... (Nottinghamshire)" -> "Nottingham"), so present as a city.
 */
function displayLocation(title, latitude, longitude) {
    return {
        get_name: () => title,
        get_level: () => GWeather.LocationLevel.CITY,
        has_coords: () => true,
        get_coords: () => [latitude, longitude],
    };
}

/** "Langley Mill · Eastwood (Nottinghamshire)" when the provider's site differs. */
function panelTitle(name, source) {
    if (!source?.name)
        return name;
    const same = source.name.toLowerCase().startsWith(name.toLowerCase()) &&
        (source.distanceM ?? 0) < 500;
    return same ? name : `${name} · ${source.name}`;
}

/** One forecast point; the subset of GWeather.Info the date menu uses. */
class ForecastPoint {
    constructor(point) {
        this._point = point;
    }

    get_value_update() {
        return [true, this._point.time];
    }

    get_value_temp(unit) {
        return [true, convertTemp(this._point.tempC, unit)];
    }

    get_icon_name() {
        return this._point.icon;
    }

    get_symbolic_icon_name() {
        return `${this._point.icon}-symbolic`;
    }
}

/** Stand-in for the WeatherClient's GWeather.Info. */
// Coarser GeoClue fixes (e.g. GeoIP) get the nearest big city's name rather
// than a possibly wrong village.
const COARSE_FIX_METRES = 5000;

class RemoteInfo {
    constructor(proxy, client, getAccuracy) {
        this._proxy = proxy;
        this._client = client;
        this._getAccuracy = getAccuracy;
        this._location = null;
        this._displayLocation = null;
        this._data = null;
        this._serial = 0;
        this._nextId = 1;
        this._handlers = new Map(); // id -> {after, callback}
    }

    // What the date menu shows as the title: the name the service resolved
    // for automatic locations, plus the provider's forecast site if it
    // differs. Only used for display; comparisons use _location.
    get location() {
        return this._displayLocation ?? this._location;
    }

    set_location(location) {
        this._location = location;
        this._displayLocation = null;
        this._data = null;
    }

    abort() {
        this._serial++;
    }

    is_valid() {
        return !!this._data?.valid;
    }

    network_error() {
        return !!this._data && !this._data.valid;
    }

    get_forecast_list() {
        return (this._data?.forecast ?? []).map(p => new ForecastPoint(p));
    }

    connect(signal, callback) {
        return this._connect(signal, callback, false);
    }

    connect_after(signal, callback) {
        return this._connect(signal, callback, true);
    }

    _connect(signal, callback, after) {
        if (signal !== 'updated')
            throw new Error(`RemoteInfo has no signal ${signal}`);
        const id = this._nextId++;
        this._handlers.set(id, {after, callback});
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    _emitUpdated() {
        const handlers = [...this._handlers.values()];
        for (const after of [false, true]) {
            for (const h of handlers.filter(x => x.after === after)) {
                try {
                    h.callback(this);
                } catch (e) {
                    logError(e, 'Weather Provider Bridge');
                }
            }
        }
    }

    update() {
        const location = this._location;
        if (!location || !location.has_coords())
            return;

        const serial = ++this._serial;
        const [latitude, longitude] = location.get_coords();
        const detached =
            location.get_level() === GWeather.LocationLevel.DETACHED;
        // Empty name: let the service name an automatic location itself,
        // unless the fix is too coarse to name a village from.
        let name = location.get_name() ?? '';
        if (detached) {
            const accuracy = this._getAccuracy();
            name = accuracy > COARSE_FIX_METRES
                ? GWeather.Location.get_world()
                    .find_nearest_city(latitude, longitude).get_name()
                : '';
        }

        this._proxy.GetForecastRemote(latitude, longitude, name,
            (result, error) => {
                if (serial !== this._serial)
                    return; // aborted or superseded

                if (error) {
                    log(`Weather Provider Bridge: ${error.message}`);
                    this._data = {valid: false, error: error.message};
                } else {
                    try {
                        this._data = JSON.parse(result[0]);
                    } catch (e) {
                        this._data = {valid: false, error: String(e)};
                    }
                    const baseName = this._data.name || name;
                    this._displayLocation = displayLocation(
                        panelTitle(baseName, this._data.source),
                        latitude, longitude);
                }
                this._emitUpdated();
            });
    }
}

export default class WeatherProviderBridge extends Extension {
    enable() {
        const client = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient;
        if (!client) {
            log('Weather Provider Bridge: calendar weather client not found');
            return;
        }
        this._client = client;
        this._originalInfo = client._weatherInfo;
        this._cancellable = new Gio.Cancellable();

        new ForecastProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
            (proxy, error) => {
                if (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`Weather Provider Bridge: ${error.message}`);
                    return;
                }
                this._install(proxy);
            }, this._cancellable);
    }

    _install(proxy) {
        const client = this._client;
        if (!client)
            return;

        const info = new RemoteInfo(proxy, client, () =>
            this._fixAccuracy ?? client._gclueService?.location?.accuracy ?? 0);
        info.set_location(this._originalInfo.location);
        // Mirrors what WeatherClient's constructor connects to its info.
        info.connect_after('updated', () => {
            client._lastUpdate = GLib.DateTime.new_now_local();
            client.emit('changed');
        });

        // WeatherClient._setLocation() compares against info.location, which
        // we rename for display; compare against the real location instead.
        client._setLocation = function (location) {
            if (this._locationsEqual(info._location, location))
                return;
            info.abort();
            info.set_location(location);
            this._locationValid = location != null;
            if (location)
                this._loadInfo();
            else
                this.emit('changed');
        };

        this._originalInfo.abort();
        client._weatherInfo = info;
        this._info = info;
        client._lastUpdate = GLib.DateTime.new_from_unix_local(0);
        if (client._locationValid)
            client._loadInfo();
        else
            client.emit('changed');

        this._startBetterGeoclue();
    }

    // The Shell asks GeoClue for CITY accuracy, which may be answered from
    // GeoIP (km out). Also ask for NEIGHBORHOOD (WiFi) and use whichever
    // fix is more accurate. Only acts while the Shell itself is following
    // the automatic location, so the user's location settings still apply.
    _startBetterGeoclue() {
        const client = this._client;
        client._onGClueLocationChanged = () => this._applyAutoLocation();
        this._reconnectShellGeoclue(client._onGClueLocationChanged);

        Geoclue.Simple.new('org.gnome.Shell',
            Geoclue.AccuracyLevel.NEIGHBORHOOD, this._cancellable,
            (_source, result) => {
                try {
                    this._geoclue = Geoclue.Simple.new_finish(result);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`Weather Provider Bridge: GeoClue: ${e.message}`);
                    return;
                }
                this._geoclueId = this._geoclue.connect('notify::location',
                    () => this._applyAutoLocation());
                this._applyAutoLocation();
            });
    }

    // Point the Shell's existing GeoClue signal at `handler`.
    _reconnectShellGeoclue(handler) {
        const client = this._client;
        if (!client._gclueLocationChangedId || !client._gclueService)
            return;
        client._gclueService.disconnect(client._gclueLocationChangedId);
        client._gclueLocationChangedId =
            client._gclueService.connect('notify::location', handler);
    }

    _applyAutoLocation() {
        const client = this._client;
        // Only while the Shell is monitoring the automatic location.
        if (!client || !client._gclueLocationChangedId)
            return;

        const fixes = [this._geoclue?.location, client._gclueService?.location]
            .filter(Boolean)
            .sort((a, b) => a.accuracy - b.accuracy);
        const fix = fixes[0];
        if (!fix)
            return;

        this._fixAccuracy = fix.accuracy;
        // Rounded to ~1 km: small jitter doesn't trigger a new fetch.
        const round = v => Math.round(v * 100) / 100;
        client._setLocation(GWeather.Location.new_detached('', null,
            round(fix.latitude), round(fix.longitude)));
    }

    _stopBetterGeoclue() {
        if (this._geoclue && this._geoclueId)
            this._geoclue.disconnect(this._geoclueId);
        this._geoclue = null;
        this._geoclueId = 0;
        this._fixAccuracy = undefined;

        const client = this._client;
        if (client && Object.hasOwn(client, '_onGClueLocationChanged')) {
            delete client._onGClueLocationChanged; // back to the prototype's
            this._reconnectShellGeoclue(client._onGClueLocationChanged.bind(client));
        }
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._stopBetterGeoclue();

        const client = this._client;
        if (client && this._info) {
            this._info.abort();
            delete client._setLocation; // back to the prototype's
            client._weatherInfo = this._originalInfo;
            this._originalInfo.set_location(this._info._location);
            client._lastUpdate = GLib.DateTime.new_from_unix_local(0);
            if (client._locationValid)
                client._loadInfo();
            else
                client.emit('changed');
        }

        this._client = null;
        this._info = null;
        this._originalInfo = null;
    }
}
