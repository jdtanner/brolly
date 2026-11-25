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

// Weather providers.
//
// "libgweather" uses libgweather's own backends (METAR, MET.no, OWM 2.5,
// NWS) exactly as upstream does. The other providers are implemented here
// on top of libsoup and produce RemoteInfo objects.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import Soup from 'gi://Soup?version=3.0';
import Secret from 'gi://Secret?version=1';

import {
    Condition,
    ForecastData,
    ForecastSource,
    Fetcher,
    GWeatherInfoAdapter,
    RemoteInfo,
    WeatherInfo,
    WeatherSample,
} from './weatherInfo.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

export type ProviderId =
    | 'libgweather'
    | 'open-meteo'
    | 'met-office'
    | 'openweathermap';

export type ProviderDescription = {
    id: ProviderId;
    name: string;
    description: string;
    needsApiKey: boolean;
    apiKeyUrl?: string;
};

export function getProviders(): ProviderDescription[] {
    return [
        {
            id: 'libgweather',
            name: _('libgweather (GNOME default)'),
            description: _(
                'METAR, MET Norway, OpenWeatherMap and NWS, as built into libgweather'
            ),
            needsApiKey: false,
        },
        {
            id: 'open-meteo',
            name: 'Open-Meteo',
            description: _('Free, no API key needed'),
            needsApiKey: false,
        },
        {
            id: 'met-office',
            name: _('Met Office'),
            description: _(
                'UK Met Office Weather DataHub site-specific forecasts'
            ),
            needsApiKey: true,
            apiKeyUrl: 'https://datahub.metoffice.gov.uk/',
        },
        {
            id: 'openweathermap',
            name: 'OpenWeatherMap',
            description: _('One Call API 3.0, using your own API key'),
            needsApiKey: true,
            apiKeyUrl: 'https://openweathermap.org/api/one-call-3',
        },
    ];
}

/** libgweather backend nicks, as stored in the libgweather-providers key. */
export const LIBGWEATHER_BACKENDS: [string, string, GWeather.Provider][] = [
    ['metar', 'METAR', GWeather.Provider.METAR],
    ['met-no', 'MET Norway (yr.no)', GWeather.Provider.MET_NO],
    ['owm', 'OpenWeatherMap', GWeather.Provider.OWM],
    ['nws', 'US National Weather Service', GWeather.Provider.NWS],
];

export const OPEN_METEO_MODELS: [string, string][] = [
    ['best_match', 'Best match'],
    ['ecmwf_ifs025', 'ECMWF IFS'],
    ['ukmo_seamless', 'UK Met Office'],
    ['icon_seamless', 'DWD ICON'],
    ['meteofrance_seamless', 'Météo-France'],
    ['gfs_seamless', 'NOAA GFS'],
    ['gem_seamless', 'Canadian GEM'],
    ['jma_seamless', 'JMA'],
    ['metno_seamless', 'MET Norway'],
];

/* ---------- API keys (libsecret) ---------- */

const SECRET_SCHEMA = (
    Secret.Schema.new as unknown as (
        name: string,
        flags: Secret.SchemaFlags,
        attributes: Record<string, Secret.SchemaAttributeType>
    ) => Secret.Schema
)('org.gnome.Weather.ApiKey', Secret.SchemaFlags.NONE, {
    provider: Secret.SchemaAttributeType.STRING,
});

// Gio._promisify() wrappers look the original up through `this`, so these
// must be called as methods of the Secret namespace, never detached.
const SecretAsync = Secret as unknown as {
    password_lookup(
        schema: Secret.Schema,
        attributes: Record<string, string>,
        cancellable: Gio.Cancellable | null
    ): Promise<string | null>;
    password_store(
        schema: Secret.Schema,
        attributes: Record<string, string>,
        collection: string | null,
        label: string,
        password: string,
        cancellable: Gio.Cancellable | null
    ): Promise<boolean>;
    password_clear(
        schema: Secret.Schema,
        attributes: Record<string, string>,
        cancellable: Gio.Cancellable | null
    ): Promise<boolean>;
};

export async function getApiKey(provider: ProviderId): Promise<string | null> {
    try {
        return await SecretAsync.password_lookup(
            SECRET_SCHEMA,
            {provider},
            null
        );
    } catch (e) {
        console.warn(`Could not read API key from keyring: ${String(e)}`);
        return null;
    }
}

export async function setApiKey(
    provider: ProviderId,
    key: string
): Promise<void> {
    key = key.trim();
    if (key) {
        await SecretAsync.password_store(
            SECRET_SCHEMA,
            {provider},
            Secret.COLLECTION_DEFAULT,
            `GNOME Weather API key (${provider})`,
            key,
            null
        );
    } else {
        await SecretAsync.password_clear(SECRET_SCHEMA, {provider}, null);
    }
    clearCache();
}

/* ---------- HTTP + on-disk cache ---------- */

// Both the app and the search-provider service fetch on start-up; a short
// shared cache keeps us well inside free-tier quotas (Met Office: 360/day).
// The search/panel service is started on demand (e.g. every time the
// calendar menu opens), so it accepts older data than the app does.
let cacheMaxAge = 5 * 60; // seconds

export function setCacheMaxAge(seconds: number): void {
    cacheMaxAge = seconds;
}

let session: Soup.Session | undefined;
function getSession(): Soup.Session {
    if (!session) {
        session = new Soup.Session({
            user_agent: `gnome-weather/${pkg.version ?? 'unknown'} (provider fork)`,
            timeout: 30,
        });
    }
    return session;
}

function cacheDir(): string {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-weather']);
}

function cachePath(key: string): string {
    const hash = GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256,
        key,
        -1
    );
    return GLib.build_filenamev([cacheDir(), `${hash}.json`]);
}

function clearCache(): void {
    const dir = Gio.File.new_for_path(cacheDir());
    try {
        const files = dir.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let fileInfo;
        while ((fileInfo = files.next_file(null)))
            dir.get_child(fileInfo.get_name()).delete(null);
    } catch {
        /* nothing cached */
    }
}

// Delete entries nothing will read again (older than the longest max age,
// the 30-day geocoding cache). Runs once per process.
let cachePruned = false;
function pruneCache(): void {
    if (cachePruned) return;
    cachePruned = true;
    const dir = Gio.File.new_for_path(cacheDir());
    const cutoff = Date.now() / 1000 - 31 * 24 * 3600;
    try {
        const files = dir.enumerate_children(
            'standard::name,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info;
        while ((info = files.next_file(null))) {
            const modified = info.get_modification_date_time()?.to_unix() ?? 0;
            if (modified < cutoff) dir.get_child(info.get_name()).delete(null);
        }
    } catch {
        /* no cache yet */
    }
}

function readCache(key: string, maxAge: number): unknown {
    pruneCache();
    try {
        const [ok, contents] = GLib.file_get_contents(cachePath(key));
        if (!ok) return undefined;
        const entry = JSON.parse(new TextDecoder().decode(contents)) as {
            time: number;
            data: unknown;
        };
        if (Date.now() / 1000 - entry.time > maxAge) return undefined;
        return entry.data;
    } catch {
        return undefined;
    }
}

function writeCache(key: string, data: unknown): void {
    try {
        GLib.mkdir_with_parents(cacheDir(), 0o700);
        GLib.file_set_contents(
            cachePath(key),
            JSON.stringify({time: Math.floor(Date.now() / 1000), data})
        );
    } catch (e) {
        console.warn(`Could not write weather cache: ${String(e)}`);
    }
}

async function getJson(
    url: string,
    headers: Record<string, string> = {},
    cacheKey: string = url,
    maxAge: number = cacheMaxAge
): Promise<unknown> {
    const cached = readCache(cacheKey, maxAge);
    if (cached !== undefined) return cached;

    const message = Soup.Message.new('GET', url);
    if (!message) throw new Error(`Invalid URL: ${url}`);
    message.request_headers.append('Accept', 'application/json');
    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    const bytes = await (
        getSession().send_and_read_async as unknown as (
            msg: Soup.Message,
            priority: number,
            cancellable: Gio.Cancellable | null
        ) => Promise<GLib.Bytes>
    ).call(getSession(), message, GLib.PRIORITY_DEFAULT, null);

    const body = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
    const status: number = message.get_status();
    if (status !== 200) {
        let detail = message.get_reason_phrase();
        try {
            const json = JSON.parse(body) as Record<string, unknown>;
            const msg = json.message ?? json.reason ?? json.httpMessage;
            if (typeof msg === 'string') detail = msg;
        } catch {
            /* not JSON */
        }
        if (status === 401 || status === 403)
            throw new Error(_('The API key was rejected (%s)').format(detail));
        throw new Error(`HTTP ${status}: ${detail}`);
    }

    const data: unknown = JSON.parse(body);
    writeCache(cacheKey, data);
    return data;
}

/* ---------- Helpers ---------- */

function coords(location: GWeather.Location): [number, number] {
    if (!location.has_coords())
        throw new Error(_('This location has no coordinates'));
    // Round to ~1 km: plenty for a forecast, shares the cache between the
    // app and the panel, and avoids sending a precise position anywhere.
    const [lat, lon] = location.get_coords();
    return [Math.round(lat * 100) / 100, Math.round(lon * 100) / 100];
}

/** Approximate solar elevation in degrees (NOAA simplified). */
function solarElevation(lat: number, lon: number, unix: number): number {
    const rad = Math.PI / 180;
    const days = unix / 86400 - 10957.5; // days since J2000
    const meanLong = (280.46 + 0.9856474 * days) % 360;
    const meanAnom = ((357.528 + 0.9856003 * days) % 360) * rad;
    const eclLong =
        (meanLong +
            1.915 * Math.sin(meanAnom) +
            0.02 * Math.sin(2 * meanAnom)) *
        rad;
    const obliquity = (23.439 - 0.0000004 * days) * rad;
    const decl = Math.asin(Math.sin(obliquity) * Math.sin(eclLong));
    const ra = Math.atan2(
        Math.cos(obliquity) * Math.sin(eclLong),
        Math.cos(eclLong)
    );
    const gmst = (18.697374558 + 24.06570982441908 * days) % 24;
    const hourAngle = (gmst * 15 + lon) * rad - ra;
    return (
        Math.asin(
            Math.sin(lat * rad) * Math.sin(decl) +
                Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle)
        ) / rad
    );
}

function isDaytime(lat: number, lon: number, unix: number): boolean {
    return solarElevation(lat, lon, unix) > -0.83;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

/** Keep the current sample plus forecasts strictly after it. */
function splitCurrent(
    current: WeatherSample,
    samples: WeatherSample[]
): ForecastData {
    return {
        current,
        forecast: samples
            .filter(s => s.time > current.time + 15 * 60)
            .sort((a, b) => a.time - b.time),
    };
}

/* ---------- Reverse geocoding (OpenStreetMap Nominatim) ---------- */

const GEOCODE_MAX_AGE = 30 * 24 * 3600;

/**
 * A human name (town/village) for a position, or null. Coordinates are
 * rounded to ~1 km before being sent; results are cached for 30 days.
 */
export async function reverseGeocode(
    lat: number,
    lon: number
): Promise<string | null> {
    lat = Math.round(lat * 100) / 100;
    lon = Math.round(lon * 100) / 100;
    const lang = (GLib.get_language_names()[0] ?? 'en').split(/[_.@]/)[0];
    const url =
        'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
        `&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&zoom=16&addressdetails=1` +
        `&accept-language=${encodeURIComponent(lang === 'C' ? 'en' : lang)}`;
    try {
        const data = (await getJson(url, {}, url, GEOCODE_MAX_AGE)) as {
            address?: Record<string, string>;
        };
        const a = data.address ?? {};
        const name =
            a.town ?? a.village ?? a.hamlet ?? a.suburb ?? a.city ?? null;
        return name ? name.replace(/ CP$/, '') : null;
    } catch (e) {
        console.warn(`Reverse geocoding failed: ${String(e)}`);
        return null;
    }
}

/* ---------- Place search (Open-Meteo geocoding / GeoNames) ---------- */

export type PlaceResult = {
    name: string;
    /** e.g. "Derbyshire, United Kingdom" */
    detail: string;
    countryCode: string;
    latitude: number;
    longitude: number;
};

/**
 * Search towns and villages by name. Uses Open-Meteo's geocoding API, which
 * (unlike Nominatim) permits search-as-you-type. Only the typed text is
 * sent. Places in the user's own country are listed first.
 */
export async function searchPlaces(query: string): Promise<PlaceResult[]> {
    query = query.trim();
    if (query.length < 2) return [];

    const lang = (GLib.get_language_names()[0] ?? 'en').split(/[_.@]/)[0];
    const url =
        'https://geocoding-api.open-meteo.com/v1/search' +
        `?name=${encodeURIComponent(query)}&count=20&format=json` +
        `&language=${encodeURIComponent(lang === 'C' ? 'en' : lang)}`;
    const data = (await getJson(url, {}, url, 24 * 3600)) as {
        results?: Record<string, unknown>[];
    };
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    const region = /^[a-z]+_([A-Z]+)/.exec(
        GLib.get_language_names()[0] ?? ''
    )?.[1];
    const places = (data.results ?? [])
        // Populated places only (PPL, PPLA, PPLC, ...), not islands etc.
        .filter(r => str(r.feature_code).startsWith('PPL'))
        .map(r => ({
            name: str(r.name),
            detail: [r.admin2 ?? r.admin1, r.country]
                .filter(x => typeof x === 'string' && x)
                .join(', '),
            countryCode: str(r.country_code),
            latitude: num(r.latitude) ?? NaN,
            longitude: num(r.longitude) ?? NaN,
        }))
        .filter(p => p.name && Number.isFinite(p.latitude));

    // Stable sort: own country first, otherwise keep the API's ranking.
    return places
        .sort(
            (a, b) =>
                Number(b.countryCode === region) -
                Number(a.countryCode === region)
        )
        .slice(0, 10);
}

/* ---------- Open-Meteo ---------- */

function wmoCondition(code: number | undefined): Condition {
    switch (code) {
        case 0:
        case 1:
            return Condition.CLEAR;
        case 2:
            return Condition.PARTLY_CLOUDY;
        case 3:
            return Condition.CLOUDY;
        case 45:
        case 48:
            return Condition.FOG;
        case 51:
        case 53:
        case 55:
            return Condition.DRIZZLE;
        case 56:
        case 57:
        case 66:
        case 67:
            return Condition.FREEZING_RAIN;
        case 61:
        case 63:
            return Condition.RAIN;
        case 65:
            return Condition.HEAVY_RAIN;
        case 71:
        case 73:
        case 75:
        case 77:
            return Condition.SNOW;
        case 80:
        case 81:
        case 82:
            return Condition.SHOWERS;
        case 85:
        case 86:
            return Condition.SNOW_SHOWERS;
        case 95:
        case 96:
        case 99:
            return Condition.THUNDERSTORM;
        default:
            return Condition.UNKNOWN;
    }
}

const OPEN_METEO_VARS = [
    'temperature_2m',
    'apparent_temperature',
    'relative_humidity_2m',
    'weather_code',
    'wind_speed_10m',
    'wind_direction_10m',
    'is_day',
].join(',');

type OpenMeteoBlock = Record<string, unknown>;

function openMeteoSample(block: OpenMeteoBlock, i?: number): WeatherSample {
    const get = (key: string): number | undefined => {
        const v = block[key];
        return num(i === undefined ? v : (v as unknown[] | undefined)?.[i]);
    };
    return {
        time: get('time') ?? 0,
        tempC: get('temperature_2m'),
        apparentC: get('apparent_temperature'),
        humidity: get('relative_humidity_2m'),
        windMs: get('wind_speed_10m'),
        windDirDeg: get('wind_direction_10m'),
        condition: wmoCondition(get('weather_code')),
        isDay: get('is_day') !== 0,
    };
}

function openMeteoFetcher(model: string): Fetcher {
    return async location => {
        const [lat, lon] = coords(location);
        const params = [
            `latitude=${lat.toFixed(2)}`,
            `longitude=${lon.toFixed(2)}`,
            `current=${OPEN_METEO_VARS}`,
            `hourly=${OPEN_METEO_VARS}`,
            'wind_speed_unit=ms',
            'timeformat=unixtime',
            'forecast_days=8',
        ];
        if (model && model !== 'best_match') params.push(`models=${model}`);
        const url = `https://api.open-meteo.com/v1/forecast?${params.join('&')}`;

        const data = (await getJson(url)) as {
            current?: OpenMeteoBlock;
            hourly?: OpenMeteoBlock;
            reason?: string;
        };
        if (!data.current || !data.hourly)
            throw new Error(data.reason ?? 'Unexpected Open-Meteo response');

        const hourly = data.hourly;
        const times = (hourly.time as number[] | undefined) ?? [];
        const samples = times
            .map((_t, i) => openMeteoSample(hourly, i))
            .filter(s => s.tempC !== undefined);

        return splitCurrent(openMeteoSample(data.current), samples);
    };
}

/* ---------- Met Office Weather DataHub ---------- */

const MET_OFFICE_BASE =
    'https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/';

function metOfficeCondition(code: number | undefined): Condition {
    switch (code) {
        case -1:
        case 11:
            return Condition.DRIZZLE;
        case 0:
        case 1:
            return Condition.CLEAR;
        case 2:
        case 3:
            return Condition.PARTLY_CLOUDY;
        case 5:
        case 6:
            return Condition.FOG;
        case 7:
        case 8:
            return Condition.CLOUDY;
        case 9:
        case 10:
        case 13:
        case 14:
            return Condition.SHOWERS;
        case 12:
            return Condition.RAIN;
        case 15:
            return Condition.HEAVY_RAIN;
        case 16:
        case 17:
        case 18:
            return Condition.SLEET;
        case 19:
        case 20:
        case 21:
            return Condition.HAIL;
        case 22:
        case 23:
        case 25:
        case 26:
            return Condition.SNOW_SHOWERS;
        case 24:
        case 27:
            return Condition.SNOW;
        case 28:
        case 29:
        case 30:
            return Condition.THUNDERSTORM;
        default:
            return Condition.UNKNOWN;
    }
}

// Codes that encode day/night explicitly.
const MET_OFFICE_NIGHT_CODES = [0, 2, 9, 13, 16, 19, 22, 25, 28];
const MET_OFFICE_DAY_CODES = [1, 3, 10, 14, 17, 20, 23, 26, 29];

function parseMetOfficeTime(time: unknown): number | undefined {
    if (typeof time !== 'string') return undefined;
    // e.g. "2023-07-05T10:00Z"
    const dt = GLib.DateTime.new_from_iso8601(
        time.replace(/T(\d\d:\d\d)Z$/, 'T$1:00Z'),
        null
    );
    return dt?.to_unix();
}

function metOfficeSample(
    entry: Record<string, unknown>,
    lat: number,
    lon: number
): WeatherSample | undefined {
    const time = parseMetOfficeTime(entry.time);
    if (time === undefined) return undefined;

    const max = num(entry.maxScreenAirTemp);
    const min = num(entry.minScreenAirTemp);
    let temp = num(entry.screenTemperature);
    if (temp === undefined && max !== undefined && min !== undefined)
        temp = (max + min) / 2;
    if (temp === undefined) return undefined;

    const code = num(entry.significantWeatherCode);
    let isDay: boolean;
    if (code !== undefined && MET_OFFICE_NIGHT_CODES.includes(code))
        isDay = false;
    else if (code !== undefined && MET_OFFICE_DAY_CODES.includes(code))
        isDay = true;
    else isDay = isDaytime(lat, lon, time);

    return {
        time,
        tempC: temp,
        apparentC: num(entry.feelsLikeTemperature) ?? num(entry.feelsLikeTemp),
        tempMinC: min,
        tempMaxC: max,
        humidity: num(entry.screenRelativeHumidity),
        windMs: num(entry.windSpeed10m),
        windDirDeg: num(entry.windDirectionFrom10m),
        condition: metOfficeCondition(code),
        isDay,
    };
}

async function metOfficeSeries(
    timesteps: string,
    lat: number,
    lon: number,
    apiKey: string
): Promise<{samples: WeatherSample[]; source?: ForecastSource}> {
    const url =
        `${MET_OFFICE_BASE}${timesteps}?latitude=${lat.toFixed(2)}` +
        `&longitude=${lon.toFixed(2)}` +
        '&excludeParameterMetadata=true&includeLocationName=true';
    const data = (await getJson(
        url,
        {apikey: apiKey},
        `met-office:${apiKey}:${url}`
    )) as {
        features?: {
            properties?: {
                timeSeries?: Record<string, unknown>[];
                location?: {name?: string};
                requestPointDistance?: number;
            };
        }[];
    };
    const properties = data.features?.[0]?.properties;
    const series = properties?.timeSeries;
    if (!series) throw new Error('Unexpected Met Office response');
    const name = properties?.location?.name;
    return {
        samples: series
            .map(e => metOfficeSample(e, lat, lon))
            .filter((s): s is WeatherSample => !!s),
        source: name
            ? {name, distanceM: num(properties?.requestPointDistance)}
            : undefined,
    };
}

const metOfficeFetcher: Fetcher = async location => {
    const apiKey = await getApiKey('met-office');
    if (!apiKey)
        throw new Error(
            _('No Met Office API key set. Add one in Preferences.')
        );

    const [lat, lon] = coords(location);
    // Hourly covers 48 h; three-hourly extends it to 7 days.
    const [hourlyResult, threeHourlyResult] = await Promise.all([
        metOfficeSeries('hourly', lat, lon, apiKey),
        metOfficeSeries('three-hourly', lat, lon, apiKey).catch(
            (e: unknown) => {
                console.warn(`Met Office three-hourly failed: ${String(e)}`);
                return {samples: [] as WeatherSample[]};
            }
        ),
    ]);
    const hourly = hourlyResult.samples;
    const threeHourly = threeHourlyResult.samples;
    if (hourly.length === 0) throw new Error('Empty Met Office forecast');

    const now = Date.now() / 1000;
    let current = hourly[0];
    for (const s of hourly) if (s.time <= now) current = s;

    const lastHourly = hourly[hourly.length - 1].time;
    return {
        ...splitCurrent(current, [
            ...hourly,
            ...threeHourly.filter(s => s.time > lastHourly),
        ]),
        source: hourlyResult.source,
    };
};

/* ---------- OpenWeatherMap One Call 3.0 ---------- */

type OwmWeather = {id?: number; icon?: string};
type OwmEntry = {
    dt: number;
    temp?: number | Record<string, number>;
    feels_like?: number | Record<string, number>;
    humidity?: number;
    wind_speed?: number;
    wind_deg?: number;
    weather?: OwmWeather[];
};

function owmCondition(id: number | undefined): Condition {
    if (id === undefined) return Condition.UNKNOWN;
    if (id >= 200 && id < 300) return Condition.THUNDERSTORM;
    if (id >= 300 && id < 400) return Condition.DRIZZLE;
    if (id === 511) return Condition.FREEZING_RAIN;
    if (id >= 520 && id < 532) return Condition.SHOWERS;
    if (id === 502 || id === 503 || id === 504) return Condition.HEAVY_RAIN;
    if (id >= 500 && id < 600) return Condition.RAIN;
    if (id >= 611 && id <= 616) return Condition.SLEET;
    if (id >= 620 && id < 700) return Condition.SNOW_SHOWERS;
    if (id >= 600 && id < 700) return Condition.SNOW;
    if (id >= 700 && id < 800) return Condition.FOG;
    if (id === 800) return Condition.CLEAR;
    if (id === 801 || id === 802) return Condition.PARTLY_CLOUDY;
    if (id >= 803 && id < 900) return Condition.CLOUDY;
    return Condition.UNKNOWN;
}

function owmSample(
    e: OwmEntry,
    lat: number,
    lon: number,
    temp?: number,
    feels?: number,
    time?: number
): WeatherSample {
    const w = e.weather?.[0];
    const t = time ?? e.dt;
    const icon = w?.icon;
    return {
        time: t,
        tempC: temp ?? num(e.temp),
        apparentC: feels ?? num(e.feels_like),
        humidity: num(e.humidity),
        windMs: num(e.wind_speed),
        windDirDeg: num(e.wind_deg),
        condition: owmCondition(w?.id),
        isDay:
            time === undefined && icon
                ? icon.endsWith('d')
                : isDaytime(lat, lon, t),
    };
}

const owmFetcher: Fetcher = async location => {
    const apiKey = await getApiKey('openweathermap');
    if (!apiKey)
        throw new Error(
            _('No OpenWeatherMap API key set. Add one in Preferences.')
        );

    const [lat, lon] = coords(location);
    const url =
        'https://api.openweathermap.org/data/3.0/onecall' +
        `?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}` +
        `&units=metric&exclude=minutely,alerts&appid=${encodeURIComponent(apiKey)}`;
    const data = (await getJson(url)) as {
        current?: OwmEntry;
        hourly?: OwmEntry[];
        daily?: OwmEntry[];
    };
    if (!data.current) throw new Error('Unexpected OpenWeatherMap response');

    const samples = (data.hourly ?? []).map(e => owmSample(e, lat, lon));
    const lastHourly = samples.length ? samples[samples.length - 1].time : 0;

    // Beyond the 48 h hourly forecast, synthesise the app's five day
    // periods from the daily entries (whose dt is local noon).
    const HOUR = 3600;
    for (const d of data.daily ?? []) {
        const temp = typeof d.temp === 'object' ? d.temp : {};
        const feels = typeof d.feels_like === 'object' ? d.feels_like : {};
        const periods: [number, string][] = [
            [-10, 'night'],
            [-5, 'morn'],
            [0, 'day'],
            [5, 'eve'],
            [10, 'night'],
        ];
        for (const [offset, key] of periods) {
            const time = d.dt + offset * HOUR;
            if (time <= lastHourly) continue;
            const s = owmSample(d, lat, lon, temp[key], feels[key], time);
            s.tempMinC = temp.min;
            s.tempMaxC = temp.max;
            samples.push(s);
        }
    }

    return splitCurrent(owmSample(data.current, lat, lon), samples);
};

/* ---------- Factory ---------- */

const ATTRIBUTIONS: Record<Exclude<ProviderId, 'libgweather'>, string> = {
    'open-meteo':
        '<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a> (CC BY 4.0)',
    'met-office':
        '<a href="https://www.metoffice.gov.uk/">Contains Met Office data</a>',
    openweathermap:
        '<a href="https://openweathermap.org/">Weather data provided by OpenWeather</a>',
};

export function getLibgweatherProviderFlags(settings: Gio.Settings): number {
    const enabled = settings.get_strv('libgweather-providers');
    let flags = 0;
    for (const [nick, , flag] of LIBGWEATHER_BACKENDS)
        if (enabled.includes(nick)) flags |= flag;
    return flags || GWeather.Provider.METAR | GWeather.Provider.MET_NO;
}

export function buildInfo(
    settings: Gio.Settings,
    location: GWeather.Location
): WeatherInfo {
    const provider = settings.get_string('provider') as ProviderId;

    switch (provider) {
        case 'open-meteo':
            return new RemoteInfo(
                location,
                ATTRIBUTIONS[provider],
                openMeteoFetcher(settings.get_string('open-meteo-model'))
            );
        case 'met-office':
            return new RemoteInfo(
                location,
                ATTRIBUTIONS[provider],
                metOfficeFetcher
            );
        case 'openweathermap':
            return new RemoteInfo(location, ATTRIBUTIONS[provider], owmFetcher);
        default:
            return new GWeatherInfoAdapter(
                new GWeather.Info({
                    application_id: pkg.name,
                    contact_info:
                        'https://gitlab.gnome.org/GNOME/gnome-weather/-/raw/master/gnome-weather.doap',
                    location,
                    enabled_providers: getLibgweatherProviderFlags(settings),
                })
            );
    }
}
