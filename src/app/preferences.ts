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

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as Util from '../misc/util.js';
import * as Providers from '../shared/providers.js';

export class PreferencesDialog extends Adw.PreferencesDialog {
    private settings: Gio.Settings;
    private handlerIds: number[] = [];
    private providerGroups = new Map<
        Providers.ProviderId,
        Adw.PreferencesGroup
    >();

    static {
        GObject.registerClass(this);
    }

    public constructor() {
        super({title: _('Preferences'), search_enabled: false});
        // Settings outlive the dialog's widgets: drop handlers on close.
        this.connect('closed', () => {
            for (const id of this.handlerIds) this.settings.disconnect(id);
            this.handlerIds = [];
        });

        this.settings = Util.getSettings('io.github.jdtanner.Brolly');

        const page = new Adw.PreferencesPage({
            title: _('Weather Provider'),
            icon_name: 'weather-few-clouds-symbolic',
        });
        this.add(page);

        page.add(this.buildProviderGroup());
        this.buildLibgweatherGroup(page);
        this.buildOpenMeteoGroup(page);
        this.buildApiKeyGroup(page, 'met-office');
        this.buildApiKeyGroup(page, 'openweathermap');

        this.watch('changed::provider', () => this.syncVisibility());
        this.syncVisibility();
    }

    private watch(signal: string, callback: () => void): void {
        this.handlerIds.push(this.settings.connect(signal, callback));
    }

    private buildProviderGroup(): Adw.PreferencesGroup {
        const providers = Providers.getProviders();
        const group = new Adw.PreferencesGroup({
            title: _('Source'),
            description: _(
                'Where forecasts come from. Changing this reloads all locations.'
            ),
        });

        const row = new Adw.ComboRow({
            title: _('Provider'),
            model: Gtk.StringList.new(providers.map(p => p.name)),
        });
        const sync = (): void => {
            const current = this.settings.get_string('provider');
            const index = providers.findIndex(p => p.id === current);
            row.selected = Math.max(index, 0);
            row.subtitle = providers[row.selected].description;
        };
        sync();
        this.watch('changed::provider', sync);
        row.connect('notify::selected', () => {
            const id = providers[row.selected]?.id;
            if (id && id !== this.settings.get_string('provider'))
                this.settings.set_string('provider', id);
        });
        group.add(row);
        return group;
    }

    private buildLibgweatherGroup(page: Adw.PreferencesPage): void {
        const group = new Adw.PreferencesGroup({
            title: _('libgweather Backends'),
            description: _(
                'libgweather merges data from all enabled backends that cover a location.'
            ),
        });

        for (const [nick, name] of Providers.LIBGWEATHER_BACKENDS) {
            const row = new Adw.SwitchRow({title: name});
            const sync = (): void => {
                row.active = this.settings
                    .get_strv('libgweather-providers')
                    .includes(nick);
            };
            sync();
            this.watch('changed::libgweather-providers', sync);
            row.connect('notify::active', () => {
                const current = this.settings.get_strv('libgweather-providers');
                const has = current.includes(nick);
                if (row.active === has) return;
                // libgweather needs at least one backend.
                if (!row.active && current.length === 1) {
                    row.active = true;
                    this.add_toast(
                        new Adw.Toast({
                            title: _('At least one backend must stay on'),
                        })
                    );
                    return;
                }
                this.settings.set_strv(
                    'libgweather-providers',
                    row.active
                        ? [...current, nick]
                        : current.filter(n => n !== nick)
                );
            });
            group.add(row);
        }

        page.add(group);
        this.providerGroups.set('libgweather', group);
    }

    private buildOpenMeteoGroup(page: Adw.PreferencesPage): void {
        const models = Providers.OPEN_METEO_MODELS;
        const group = new Adw.PreferencesGroup({title: 'Open-Meteo'});

        const row = new Adw.ComboRow({
            title: _('Weather Model'),
            subtitle: _('“Best match” picks the best model for each location'),
            model: Gtk.StringList.new(models.map(([, name]) => name)),
        });
        const current = this.settings.get_string('open-meteo-model');
        row.selected = Math.max(
            models.findIndex(([id]) => id === current),
            0
        );
        row.connect('notify::selected', () => {
            const id = models[row.selected]?.[0];
            if (id) this.settings.set_string('open-meteo-model', id);
        });
        group.add(row);

        page.add(group);
        this.providerGroups.set('open-meteo', group);
    }

    private buildApiKeyGroup(
        page: Adw.PreferencesPage,
        id: Providers.ProviderId
    ): void {
        const provider = Providers.getProviders().find(p => p.id === id);
        if (!provider) return;

        const group = new Adw.PreferencesGroup({
            title: provider.name,
            description: _(
                'Get a free API key from <a href="%s">%s</a>. It is stored in your keyring.'
            ).format(provider.apiKeyUrl ?? '', provider.apiKeyUrl ?? ''),
        });

        const entry = new Adw.PasswordEntryRow({
            title: _('API Key'),
            show_apply_button: true,
        });
        void Providers.getApiKey(id).then(key => {
            if (key) entry.text = key;
        });
        entry.connect('apply', () => {
            Providers.setApiKey(id, entry.text)
                .then(() => {
                    this.add_toast(new Adw.Toast({title: _('API key saved')}));
                    // Reload with the new key if this provider is active.
                    if (this.settings.get_string('provider') === id)
                        getApp()?.model.rebuildInfos();
                })
                .catch((e: unknown) => {
                    this.add_toast(
                        new Adw.Toast({
                            title: _('Could not save API key: %s').format(
                                String(e)
                            ),
                        })
                    );
                });
        });
        group.add(entry);

        page.add(group);
        this.providerGroups.set(id, group);
    }

    private syncVisibility(): void {
        const current = this.settings.get_string('provider');
        for (const [id, group] of this.providerGroups)
            group.visible = id === current;
    }
}
