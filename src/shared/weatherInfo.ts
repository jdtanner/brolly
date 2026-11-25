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

// A provider-neutral weather info object.
//
// The UI used to consume GWeather.Info directly. GWeather.Info is a final
// type, so instead the UI now talks to WeatherInfo, which has the subset of
// the GWeather.Info API the app uses (same method names, so the rest of the
// code barely changes). There are two implementations:
//
//  * GWeatherInfoAdapter wraps a real GWeather.Info (libgweather providers).
//  * DataInfo holds plain values produced by one of our own providers
//    (see providers.ts); RemoteInfo is the "current conditions" DataInfo that
//    knows how to fetch itself and owns the forecast list.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GWeather from 'gi://GWeather';

export class WeatherInfo extends GObject.Object {
    public readonly location: GWeather.Location;

    // Book-keeping used by WorldModel.
    public _isCurrentLocation?: boolean;
    public _loadingId?: number;

    static {
        GObject.registerClass(
            {
                GTypeName: 'GnomeWeatherInfo',
                Signals: {updated: {}},
            },
            this
        );
    }

    public constructor(params: {location: GWeather.Location}) {
        super();
        this.location = params.location;
    }

    public get_location(): GWeather.Location {
        return this.location;
    }

    public get_location_name(): string {
        return this.location.get_name() ?? '';
    }

    public update(): void {}
    public is_valid(): boolean {
        return false;
    }
    public get_forecast_list(): WeatherInfo[] {
        return [];
    }
    public get_attribution(): string {
        return '';
    }
    public get_icon_name(): string {
        return 'weather-severe-alert';
    }
    public get_conditions(): string {
        return '-';
    }
    public get_sky(): string {
        return '-';
    }
    public get_temp(): string {
        return '-';
    }
    public get_temp_min(): string {
        return '-';
    }
    public get_temp_max(): string {
        return '-';
    }
    public get_temp_summary(): string {
        return this.get_temp();
    }
    public get_humidity(): string {
        return '-';
    }
    public get_wind(): string {
        return '-';
    }
    public get_value_temp(_unit: GWeather.TemperatureUnit): [boolean, number] {
        return [false, 0];
    }
    public get_value_temp_min(
        _unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return [false, 0];
    }
    public get_value_temp_max(
        _unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return [false, 0];
    }
    public get_value_apparent(
        _unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return [false, 0];
    }
    public get_value_wind(_unit: GWeather.SpeedUnit): [boolean, number] {
        return [false, 0];
    }
    /** Unix timestamp the data applies to (observation or forecast time). */
    public get_value_update(): [boolean, number] {
        return [false, 0];
    }
    /** Formatted wind speed in the user's unit, e.g. "4.2 m/s". */
    public getWindSpeedString(): string {
        return this.get_wind();
    }
}

/* ---------- libgweather-backed implementation ---------- */

export class GWeatherInfoAdapter extends WeatherInfo {
    private inner: GWeather.Info;

    static {
        GObject.registerClass(this);
    }

    public constructor(inner: GWeather.Info, forwardUpdates = true) {
        super({location: inner.get_location()});
        this.inner = inner;
        if (forwardUpdates)
            this.inner.connect('updated', () => this.emit('updated'));
    }

    public override update(): void {
        this.inner.update();
    }
    public override is_valid(): boolean {
        return this.inner.is_valid();
    }
    public override get_forecast_list(): WeatherInfo[] {
        return this.inner
            .get_forecast_list()
            .map(i => new GWeatherInfoAdapter(i, false));
    }
    public override get_attribution(): string {
        return this.inner.get_attribution();
    }
    public override get_icon_name(): string {
        return this.inner.get_icon_name() ?? 'weather-severe-alert';
    }
    public override get_conditions(): string {
        return this.inner.get_conditions();
    }
    public override get_sky(): string {
        return this.inner.get_sky();
    }
    public override get_temp(): string {
        return this.inner.get_temp();
    }
    public override get_temp_min(): string {
        return this.inner.get_temp_min();
    }
    public override get_temp_max(): string {
        return this.inner.get_temp_max();
    }
    public override get_temp_summary(): string {
        return this.inner.get_temp_summary();
    }
    public override get_humidity(): string {
        return this.inner.get_humidity();
    }
    public override get_wind(): string {
        return this.inner.get_wind();
    }
    public override get_value_temp(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.inner.get_value_temp(unit);
    }
    public override get_value_temp_min(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.inner.get_value_temp_min(unit);
    }
    public override get_value_temp_max(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.inner.get_value_temp_max(unit);
    }
    public override get_value_apparent(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.inner.get_value_apparent(unit);
    }
    public override get_value_wind(
        unit: GWeather.SpeedUnit
    ): [boolean, number] {
        const [ok, speed] = this.inner.get_value_wind(unit);
        return [ok, speed];
    }
    public override get_value_update(): [boolean, number] {
        return this.inner.get_value_update();
    }
    public override getWindSpeedString(): string {
        const [ok, speed] = this.inner.get_value_wind(
            GWeather.SpeedUnit.DEFAULT
        );
        if (ok) {
            return `${speed.toFixed(1)} ${GWeather.speed_unit_to_string(GWeather.SpeedUnit.DEFAULT)}`;
        }
        return this.inner.get_wind();
    }
}

/* ---------- Units ---------- */

let gweatherSettings: Gio.Settings | null | undefined;
function getGWeatherSettings(): Gio.Settings | null {
    if (gweatherSettings === undefined) {
        const source = Gio.SettingsSchemaSource.get_default();
        gweatherSettings = source?.lookup('org.gnome.GWeather4', true)
            ? new Gio.Settings({schema_id: 'org.gnome.GWeather4'})
            : null;
    }
    return gweatherSettings;
}

export function realTemperatureUnit(
    unit: GWeather.TemperatureUnit
): GWeather.TemperatureUnit {
    return GWeather.temperature_unit_to_real(unit);
}

export function realSpeedUnit(unit: GWeather.SpeedUnit): GWeather.SpeedUnit {
    if (
        unit !== GWeather.SpeedUnit.DEFAULT &&
        unit !== GWeather.SpeedUnit.INVALID
    )
        return unit;

    const setting = getGWeatherSettings()?.get_enum('speed-unit');
    if (
        setting !== undefined &&
        setting !== GWeather.SpeedUnit.DEFAULT &&
        setting !== GWeather.SpeedUnit.INVALID
    )
        return setting as GWeather.SpeedUnit;

    // Same rule libgweather uses: imperial if the locale uses Fahrenheit.
    return realTemperatureUnit(GWeather.TemperatureUnit.DEFAULT) ===
        GWeather.TemperatureUnit.FAHRENHEIT
        ? GWeather.SpeedUnit.MPH
        : GWeather.SpeedUnit.KPH;
}

function convertTemp(celsius: number, unit: GWeather.TemperatureUnit): number {
    switch (realTemperatureUnit(unit)) {
        case GWeather.TemperatureUnit.FAHRENHEIT:
            return (celsius * 9) / 5 + 32;
        case GWeather.TemperatureUnit.KELVIN:
            return celsius + 273.15;
        default:
            return celsius;
    }
}

function temperatureSuffix(): string {
    switch (realTemperatureUnit(GWeather.TemperatureUnit.DEFAULT)) {
        case GWeather.TemperatureUnit.FAHRENHEIT:
            return ' °F';
        case GWeather.TemperatureUnit.KELVIN:
            return ' K';
        default:
            return ' °C';
    }
}

function msToBeaufort(ms: number): number {
    const limits = [
        0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7,
    ];
    const i = limits.findIndex(l => ms < l);
    return i === -1 ? 12 : i;
}

function convertSpeed(ms: number, unit: GWeather.SpeedUnit): number {
    switch (realSpeedUnit(unit)) {
        case GWeather.SpeedUnit.KPH:
            return ms * 3.6;
        case GWeather.SpeedUnit.MPH:
            return ms * 2.236936;
        case GWeather.SpeedUnit.KNOTS:
            return ms * 1.943844;
        case GWeather.SpeedUnit.BFT:
            return msToBeaufort(ms);
        default:
            return ms;
    }
}

function formatTemp(celsius: number | undefined): string {
    if (celsius === undefined) return '-';
    const value = convertTemp(celsius, GWeather.TemperatureUnit.DEFAULT);
    return `${value.toFixed(1)}${temperatureSuffix()}`;
}

/* ---------- Conditions ---------- */

export enum Condition {
    CLEAR,
    PARTLY_CLOUDY,
    CLOUDY,
    FOG,
    DRIZZLE,
    RAIN,
    HEAVY_RAIN,
    SHOWERS,
    FREEZING_RAIN,
    SLEET,
    SNOW,
    SNOW_SHOWERS,
    HAIL,
    THUNDERSTORM,
    UNKNOWN,
}

function conditionIcon(condition: Condition, isDay: boolean): string {
    switch (condition) {
        case Condition.CLEAR:
            return isDay ? 'weather-clear' : 'weather-clear-night';
        case Condition.PARTLY_CLOUDY:
            return isDay ? 'weather-few-clouds' : 'weather-few-clouds-night';
        case Condition.CLOUDY:
            return 'weather-overcast';
        case Condition.FOG:
            return 'weather-fog';
        case Condition.DRIZZLE:
        case Condition.SHOWERS:
            return 'weather-showers-scattered';
        case Condition.RAIN:
        case Condition.HEAVY_RAIN:
        case Condition.FREEZING_RAIN:
            return 'weather-showers';
        case Condition.SLEET:
        case Condition.SNOW:
        case Condition.SNOW_SHOWERS:
        case Condition.HAIL:
            return 'weather-snow';
        case Condition.THUNDERSTORM:
            return 'weather-storm';
        default:
            return 'weather-severe-alert';
    }
}

function conditionText(condition: Condition): string {
    switch (condition) {
        case Condition.CLEAR:
            return _('Clear sky');
        case Condition.PARTLY_CLOUDY:
            return _('Partly cloudy');
        case Condition.CLOUDY:
            return _('Cloudy');
        case Condition.FOG:
            return _('Fog');
        case Condition.DRIZZLE:
            return _('Drizzle');
        case Condition.RAIN:
            return _('Rain');
        case Condition.HEAVY_RAIN:
            return _('Heavy rain');
        case Condition.SHOWERS:
            return _('Showers');
        case Condition.FREEZING_RAIN:
            return _('Freezing rain');
        case Condition.SLEET:
            return _('Sleet');
        case Condition.SNOW:
            return _('Snow');
        case Condition.SNOW_SHOWERS:
            return _('Snow showers');
        case Condition.HAIL:
            return _('Hail');
        case Condition.THUNDERSTORM:
            return _('Thunderstorm');
        default:
            return '-';
    }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/* ---------- Data-backed implementation ---------- */

/** One point in time, as returned by a provider. All values are metric. */
export type WeatherSample = {
    /** Unix timestamp (seconds). */
    time: number;
    tempC?: number;
    apparentC?: number;
    tempMinC?: number;
    tempMaxC?: number;
    /** Relative humidity, 0-100. */
    humidity?: number;
    windMs?: number;
    /** Direction the wind comes from, degrees. */
    windDirDeg?: number;
    condition: Condition;
    isDay: boolean;
};

export class DataInfo extends WeatherInfo {
    protected sample?: WeatherSample;
    protected attribution: string;

    static {
        GObject.registerClass(this);
    }

    public constructor(
        location: GWeather.Location,
        attribution: string,
        sample?: WeatherSample
    ) {
        super({location});
        this.attribution = attribution;
        this.sample = sample;
    }

    public override is_valid(): boolean {
        return !!this.sample;
    }
    public override get_attribution(): string {
        return this.attribution;
    }
    public override get_icon_name(): string {
        if (!this.sample) return 'weather-severe-alert';
        return conditionIcon(this.sample.condition, this.sample.isDay);
    }
    public override get_conditions(): string {
        return this.sample ? conditionText(this.sample.condition) : '-';
    }
    public override get_sky(): string {
        return this.get_conditions();
    }
    public override get_temp(): string {
        return formatTemp(this.sample?.tempC);
    }
    public override get_temp_min(): string {
        return formatTemp(this.sample?.tempMinC);
    }
    public override get_temp_max(): string {
        return formatTemp(this.sample?.tempMaxC);
    }
    public override get_humidity(): string {
        const h = this.sample?.humidity;
        return h === undefined ? '-' : `${Math.round(h)}%`;
    }
    public override get_wind(): string {
        const s = this.sample;
        if (s?.windMs === undefined) return '-';
        const speed = this.getWindSpeedString();
        if (s.windMs < 0.3 || s.windDirDeg === undefined) return speed;
        const dir = COMPASS[Math.round(s.windDirDeg / 45) % 8];
        return `${dir} / ${speed}`;
    }
    public override getWindSpeedString(): string {
        const [ok, speed] = this.get_value_wind(GWeather.SpeedUnit.DEFAULT);
        if (!ok) return '-';
        const unit = realSpeedUnit(GWeather.SpeedUnit.DEFAULT);
        if (unit === GWeather.SpeedUnit.BFT) return _('Force %d').format(speed);
        return `${speed.toFixed(1)} ${GWeather.speed_unit_to_string(unit)}`;
    }

    private tempValue(
        value: number | undefined,
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        if (value === undefined) return [false, 0];
        return [true, convertTemp(value, unit)];
    }
    public override get_value_temp(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.tempValue(this.sample?.tempC, unit);
    }
    public override get_value_temp_min(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.tempValue(this.sample?.tempMinC, unit);
    }
    public override get_value_temp_max(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.tempValue(this.sample?.tempMaxC, unit);
    }
    public override get_value_apparent(
        unit: GWeather.TemperatureUnit
    ): [boolean, number] {
        return this.tempValue(
            this.sample?.apparentC ?? this.sample?.tempC,
            unit
        );
    }
    public override get_value_wind(
        unit: GWeather.SpeedUnit
    ): [boolean, number] {
        const ms = this.sample?.windMs;
        if (ms === undefined) return [false, 0];
        return [true, convertSpeed(ms, unit)];
    }
    public override get_value_update(): [boolean, number] {
        return this.sample ? [true, this.sample.time] : [false, 0];
    }
}

export type ForecastData = {
    current: WeatherSample;
    /** Time-ordered forecast samples, all later than current.time. */
    forecast: WeatherSample[];
};

export type Fetcher = (location: GWeather.Location) => Promise<ForecastData>;

/** Current conditions for a location; fetches itself through a provider. */
export class RemoteInfo extends DataInfo {
    private fetcher: Fetcher;
    private forecast: DataInfo[] = [];
    private fetching = false;
    private lastError?: string;

    static {
        GObject.registerClass(this);
    }

    public constructor(
        location: GWeather.Location,
        attribution: string,
        fetcher: Fetcher
    ) {
        super(location, attribution);
        this.fetcher = fetcher;
    }

    public override update(): void {
        if (this.fetching) return;
        this.fetching = true;

        this.fetcher(this.location)
            .then(data => {
                this.sample = data.current;
                this.forecast = data.forecast.map(
                    s => new DataInfo(this.location, this.attribution, s)
                );
                this.lastError = undefined;
            })
            .catch((e: unknown) => {
                this.lastError = e instanceof Error ? e.message : String(e);
                console.warn(
                    `Weather update for ${this.get_location_name()} failed: ${this.lastError}`
                );
            })
            .finally(() => {
                this.fetching = false;
                this.emit('updated');
            });
    }

    public getError(): string | undefined {
        return this.lastError;
    }

    public override get_forecast_list(): WeatherInfo[] {
        return this.forecast;
    }
}
