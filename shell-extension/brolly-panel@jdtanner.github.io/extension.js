// Brolly Panel Weather
//
// GNOME Shell's calendar-menu weather (js/misc/weather.js) is built for
// GNOME Weather: it looks for the org.gnome.Weather app, takes its saved
// places over D-Bus, and fetches the forecast itself through libgweather
// with fixed backends. This extension points it at Brolly instead:
//
//  * the weather section is shown when Brolly is installed, and opens it;
//  * Brolly's saved places come from its background service (GetLocations)
//    and are handed to the Shell through org.gnome.shell.weather, exactly as
//    GNOME Weather's integration does;
//  * the forecast itself comes from Brolly's GetForecast, so the panel uses
//    the provider and cache the app uses;
//  * the automatic location uses a neighbourhood-accuracy GeoClue fix (the
//    Shell only asks for city accuracy, which may be km out).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Geoclue from 'gi://Geoclue';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const APP_ID = 'io.github.jdtanner.Brolly';
const BUS_NAME = `${APP_ID}.BackgroundService`;
const OBJECT_PATH = '/io/github/jdtanner/Brolly/BackgroundService';
const ForecastIface = `
<node>
  <interface name="${APP_ID}.Forecast">
    <method name="GetForecast">
      <arg type="d" name="latitude" direction="in"/>
      <arg type="d" name="longitude" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="GetLocations">
      <arg type="b" name="automatic" direction="out"/>
      <arg type="av" name="locations" direction="out"/>
    </method>
  </interface>
</node>`;
const ForecastProxy = Gio.DBusProxy.makeProxyWrapper(ForecastIface);

// Fixes less accurate than this get the nearest big city's name rather than
// a possibly wrong village.
const COARSE_FIX_METRES = 5000;

const round = v => Math.round(v * 100) / 100;

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
 * Title for the date menu. The menu shortens titles of non-city locations
 * to the nearest libgweather city when that city's name appears in them
 * ("... (Nottinghamshire)" -> "Nottingham"), so present as a city.
 */
function displayLocation(title, latitude, longitude) {
    return {
        get_name: () => title,
        get_level: () => GWeather.LocationLevel.CITY,
        has_coords: () => true,
        get_coords: () => [latitude, longitude],
    };
}

/** "Langley Mill · Heanor" when the provider forecasts for another site. */
function panelTitle(name, source) {
    if (!source?.name)
        return name;
    // "Ilkeston" / "Ilkeston (Derbyshire)" is the same place for a title.
    const same = source.name.toLowerCase().startsWith(name.toLowerCase());
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

/** Stand-in for the WeatherClient's GWeather.Info, fed by Brolly. */
class RemoteInfo {
    constructor(proxy, hooks) {
        this._proxy = proxy;
        this._hooks = hooks; // {isAutomatic(loc), accuracy(), beforeUpdate()}
        this._location = null;
        this._displayLocation = null;
        this._data = null;
        this._serial = 0;
        this._nextId = 1;
        this._handlers = new Map(); // id -> {after, callback}
    }

    // Shown as the menu title; comparisons use _location.
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
                    logError(e, 'Brolly Panel Weather');
                }
            }
        }
    }

    update() {
        this._hooks.beforeUpdate();

        const location = this._location;
        if (!location || !location.has_coords())
            return;

        const serial = ++this._serial;
        const [latitude, longitude] = location.get_coords();

        // The automatic location is named by Brolly from its coordinates
        // (empty name), unless the fix is too coarse to name a village from.
        // Saved places, including towns from Brolly's search, keep theirs.
        let name = location.get_name() ?? '';
        if (this._hooks.isAutomatic(location)) {
            name = this._hooks.accuracy() > COARSE_FIX_METRES
                ? GWeather.Location.get_world()
                    .find_nearest_city(latitude, longitude).get_name()
                : '';
        }

        this._proxy.GetForecastRemote(latitude, longitude, name,
            (result, error) => {
                if (serial !== this._serial)
                    return; // aborted or superseded

                if (error) {
                    log(`Brolly Panel Weather: ${error.message}`);
                    this._data = {valid: false, error: error.message};
                } else {
                    try {
                        this._data = JSON.parse(result[0]);
                    } catch (e) {
                        this._data = {valid: false, error: String(e)};
                    }
                    this._displayLocation = displayLocation(
                        panelTitle(this._data.name || name, this._data.source),
                        latitude, longitude);
                }
                this._emitUpdated();
            });
    }
}

export default class BrollyPanelExtension extends Extension {
    enable() {
        const client = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient;
        if (!client) {
            log('Brolly Panel Weather: calendar weather client not found');
            return;
        }
        this._client = client;
        this._originalInfo = client._weatherInfo;
        this._cancellable = new Gio.Cancellable();
        this._shellWeatherSettings = new Gio.Settings({schema_id: 'org.gnome.shell.weather'});

        this._installAppHooks();

        new ForecastProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
            (proxy, error) => {
                if (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`Brolly Panel Weather: ${error.message}`);
                    return;
                }
                this._proxy = proxy;
                this._install(proxy);
            }, this._cancellable);
    }

    // The Shell only shows the weather section when GNOME Weather is
    // installed; show it for Brolly and open Brolly when it is clicked.
    _installAppHooks() {
        const client = this._client;
        const appSystem = Shell.AppSystem.get_default();
        const lookup = () => appSystem.lookup_app(`${APP_ID}.desktop`);
        this._brollyApp = lookup();
        this._installedId = appSystem.connect('installed-changed', () => {
            this._brollyApp = lookup();
            client.emit('changed');
        });

        Object.defineProperty(client, 'available', {
            configurable: true,
            get: () => this._brollyApp != null,
        });
        client.activateApp = () => this._brollyApp?.activate();
        client.emit('changed');
    }

    // Copy Brolly's places to where the Shell reads them, as GNOME Weather's
    // integration does. Called on enable and each time the menu refreshes.
    _syncLocations() {
        if (!this._proxy || this._syncing)
            return;
        this._syncing = true;
        this._proxy.GetLocationsRemote((result, error) => {
            this._syncing = false;
            if (error || !this._shellWeatherSettings)
                return;
            const [automatic, locations] = result;
            const settings = this._shellWeatherSettings;
            const value = new GLib.Variant('av', locations);
            if (settings.get_boolean('automatic-location') !== automatic)
                settings.set_boolean('automatic-location', automatic);
            if (!settings.get_value('locations').equal(value))
                settings.set_value('locations', value);
        });
    }

    _install(proxy) {
        const client = this._client;
        if (!client)
            return;

        const info = new RemoteInfo(proxy, {
            isAutomatic: loc => loc != null && (loc === this._autoLocation ||
                loc === this._initialAutoLocation),
            accuracy: () => this._fixAccuracy ??
                client._gclueService?.location?.accuracy ?? 0,
            beforeUpdate: () => this._syncLocations(),
        });

        // If the Shell is already showing its automatic location, it's the
        // one it built from GeoClue: treat it as automatic too.
        const current = this._originalInfo.location;
        if (current && client._gclueLocationChangedId &&
            current.get_level() === GWeather.LocationLevel.DETACHED)
            this._initialAutoLocation = current;

        info.set_location(current);
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

        this._syncLocations();
        if (client._locationValid)
            client._loadInfo();
        else
            client.emit('changed');

        this._startBetterGeoclue();
    }

    // Ask GeoClue for NEIGHBORHOOD accuracy too, and use whichever fix is
    // more accurate. Only acts while the Shell follows the automatic
    // location, so the user's location settings still apply.
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
                        log(`Brolly Panel Weather: GeoClue: ${e.message}`);
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
        if (!client || !client._gclueLocationChangedId)
            return;

        const fix = [this._geoclue?.location, client._gclueService?.location]
            .filter(Boolean)
            .sort((a, b) => a.accuracy - b.accuracy)[0];
        if (!fix)
            return;

        this._fixAccuracy = fix.accuracy;
        // Rounded to ~1 km: small jitter doesn't trigger a new fetch.
        this._autoLocation = GWeather.Location.new_detached('', null,
            round(fix.latitude), round(fix.longitude));
        client._setLocation(this._autoLocation);
    }

    _stopBetterGeoclue() {
        if (this._geoclue && this._geoclueId)
            this._geoclue.disconnect(this._geoclueId);
        this._geoclue = null;
        this._geoclueId = 0;
        this._fixAccuracy = undefined;
        this._autoLocation = null;
        this._initialAutoLocation = null;

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
        if (client) {
            if (this._installedId)
                Shell.AppSystem.get_default().disconnect(this._installedId);
            delete client.available; // back to the prototype getters
            delete client.activateApp;
        }

        if (client && this._info) {
            this._info.abort();
            delete client._setLocation;
            client._weatherInfo = this._originalInfo;
            this._originalInfo.set_location(this._info._location);
            client._lastUpdate = GLib.DateTime.new_from_unix_local(0);
            if (client._locationValid)
                client._loadInfo();
        }
        client?.emit('changed');

        this._client = null;
        this._info = null;
        this._proxy = null;
        this._originalInfo = null;
        this._brollyApp = null;
        this._installedId = 0;
        this._shellWeatherSettings = null;
    }
}
