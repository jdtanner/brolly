// -*- Mode: js; indent-tabs-mode: nil; c-basic-offset: 4; tab-width: 4 -*-
//
// Brolly is free software; you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free
// Software Foundation; either version 2 of the License, or (at your option)
// any later version.
//
// One-time import of settings and API keys from the pre-rename build of this
// fork (app ID org.gnome.Weather, which shares its settings schema with
// GNOME Weather itself: saved places carry over from GNOME Weather too).

import Gio from 'gi://Gio';
import Secret from 'gi://Secret?version=1';

import * as Providers from './providers.js';

const OLD_SCHEMA = 'org.gnome.Weather';
const KEYS = [
    'locations',
    'provider',
    'libgweather-providers',
    'open-meteo-model',
    'window-width',
    'window-height',
    'window-maximized',
];

const OLD_SECRET_SCHEMA = (
    Secret.Schema.new as unknown as (
        name: string,
        flags: Secret.SchemaFlags,
        attributes: Record<string, Secret.SchemaAttributeType>
    ) => Secret.Schema
)('org.gnome.Weather.ApiKey', Secret.SchemaFlags.NONE, {
    provider: Secret.SchemaAttributeType.STRING,
});

/** Copy old settings into `settings` once. Returns true if it ran. */
export function migrateSettings(settings: Gio.Settings): boolean {
    if (settings.get_boolean('migrated-from-gnome-weather')) return false;
    settings.set_boolean('migrated-from-gnome-weather', true);

    const source = Gio.SettingsSchemaSource.get_default();
    const oldSchema = source?.lookup(OLD_SCHEMA, true);
    if (!oldSchema) return false;

    const old = new Gio.Settings({settings_schema: oldSchema});
    for (const key of KEYS) {
        if (!oldSchema.has_key(key)) continue;
        const value = old.get_user_value(key);
        // Only values the user actually changed; never overwrite new ones.
        if (value && !settings.get_user_value(key)) {
            try {
                settings.set_value(key, value);
            } catch (e) {
                console.warn(`Could not migrate ${key}: ${String(e)}`);
            }
        }
    }
    return true;
}

/** Copy API keys stored under the old keyring schema, if any. */
export async function migrateApiKeys(): Promise<void> {
    for (const provider of ['met-office', 'openweathermap'] as const) {
        try {
            if (await Providers.getApiKey(provider)) continue;
            const oldKey = Secret.password_lookup_sync(
                OLD_SECRET_SCHEMA,
                {provider},
                null
            );
            if (oldKey) await Providers.setApiKey(provider, oldKey);
        } catch (e) {
            console.warn(`Could not migrate ${provider} key: ${String(e)}`);
        }
    }
}
