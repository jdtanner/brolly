# Weather

Monitor the current weather conditions for your city, or anywhere in the world.

## About this fork: alternative weather providers

This fork lets you choose where weather data comes from
(**Menu → Preferences**, or <kbd>Ctrl</kbd>+<kbd>,</kbd>):

| Provider | API key | Notes |
| --- | --- | --- |
| libgweather (default) | no | Upstream behaviour. Each backend (METAR, MET Norway, OpenWeatherMap, NWS) can be switched on or off. |
| [Open-Meteo](https://open-meteo.com/) | no | Hourly data for 8 days. You can pick the weather model (ECMWF, UK Met Office, DWD ICON, …). |
| [Met Office DataHub](https://datahub.metoffice.gov.uk/) | yes (free tier) | Site-specific forecasts: hourly for 48 h, then three-hourly up to 7 days. |
| [OpenWeatherMap One Call 3.0](https://openweathermap.org/api/one-call-3) | yes | Hourly for 48 h, then built from daily data. |

API keys are kept in the login keyring (libsecret), not in dconf. Responses
are cached for 5 minutes in `~/.cache/gnome-weather/`, and the app and the
search provider share that cache, so free-tier quotas last.

Settings: `org.gnome.Weather` `provider`, `libgweather-providers` and
`open-meteo-model`.

How it works: the UI now talks to `WeatherInfo` (`src/shared/weatherInfo.ts`)
instead of `GWeather.Info`. `WeatherInfo` keeps the GWeather.Info methods the
app uses. `GWeatherInfoAdapter` wraps libgweather, and `RemoteInfo`/`DataInfo`
hold data fetched by the providers in `src/shared/providers.ts`. To add a
provider, write a `Fetcher` that returns metric `WeatherSample`s and register
it in `getProviders()`/`buildInfo()`.

GNOME Shell's own weather (in the calendar menu) still uses libgweather
directly, so this setting doesn't change it.

## Useful links

**Homepage**: https://apps.gnome.org/Weather/

**Report issues**: https://gitlab.gnome.org/GNOME/gnome-weather/issues/

**Donate**: https://www.gnome.org/donate/

**Translate**: https://l10n.gnome.org/module/gnome-weather/

## Installation

There are two supported ways to install Weather:

### Stable Release

The latest stable release is available on Flathub:

<a href='https://flathub.org/apps/details/org.gnome.Weather'><img width='240' alt='Download on Flathub' src='https://flathub.org/api/badge?svg&locale=en'/></a>

### Development Snapshot

This is for testing only. To start, add the GNOME nightly repository:

```
$ flatpak remote-add gnome-nightly https://nightly.gnome.org/gnome-nightly.flatpakrepo
```

Then, run the following command to install the development version of Weather:

```
$ flatpak install org.gnome.WeatherDevel
```

## Hacking on Weather

To start working on Weather see the [general guide](https://welcome.gnome.org/app/Weather/#getting-the-app-to-build) for building GNOME apps
with Flatpak and GNOME Builder. Then, [find a task](https://gitlab.gnome.org/GNOME/gnome-weather/issues?label_name%5B%5D=4.+Newcomers) to work on.

If you're unfamiliar with GJS, here are a few good places to start:

* The [beginner-level guide](https://gjs-guide.gitlab.io/) for working with GJS
* An overview of [working with GNOME APIs via GJS](https://gitlab.gnome.org/GNOME/gjs/wikis/Mapping)
* The [documentation for various GNOME libraries](https://devdocs.baznga.org/) in JavaScript

## Communication

If you want to chat with the maintainers, we're on Matrix at [#weather:gnome.org](https://matrix.to/#/#weather:gnome.org)

