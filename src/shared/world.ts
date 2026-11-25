// -*- Mode: js; indent-tabs-mode: nil; c-basic-offset: 4; tab-width: 4 -*-
//
// Copyright (c) 2012 Giovanni Campagna <scampa.giovanni@gmail.com>
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

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GWeather from 'gi://GWeather';

import * as Util from '../misc/util.js';
import * as Providers from './providers.js';
import {WeatherInfo} from './weatherInfo.js';

type GWeatherInfoData = WeatherInfo;

export class WorldModel extends GObject.Object {
    private world?: GWeather.Location;
    private settings: Gio.Settings;
    private loadingCount: number;
    private currentLocationInfo?: GWeatherInfoData;
    private selectedLocation?: GWeatherInfoData;
    private infoList: GWeatherInfoData[];
    private allInfos: GWeatherInfoData[];
    private queueSaveSettingsId?: number;

    static {
        GObject.registerClass(
            {
                Signals: {
                    'selected-location-changed': {
                        param_types: [WeatherInfo.$gtype],
                    },
                },
                Properties: {
                    loading: GObject.ParamSpec.boolean(
                        'loading',
                        '',
                        '',
                        GObject.ParamFlags.READABLE,
                        false
                    ),
                },
                Implements: [Gio.ListModel],
            },
            this
        );
    }

    public constructor(world?: GWeather.Location) {
        super();

        this.world = world;

        this.settings = Util.getSettings('org.gnome.Weather');
        for (const key of [
            'provider',
            'libgweather-providers',
            'open-meteo-model',
        ]) {
            this.settings.connect(`changed::${key}`, () => this.rebuildInfos());
        }

        this.loadingCount = 0;

        this.infoList = [];
        this.allInfos = [];
        this.getAll();
    }

    public get length(): number {
        return this.allInfos.length;
    }

    public getAll(): GWeatherInfoData[] {
        // Ensure the current location and selected location are returned first...
        const infos = [...this.infoList].filter(
            info =>
                !this.isCurrentLocation(info) && !this.isSelectedLocation(info)
        );

        if (this.currentLocationInfo) infos.unshift(this.currentLocationInfo);

        if (
            this.selectedLocation &&
            this.currentLocationInfo !== this.selectedLocation
        ) {
            infos.unshift(this.selectedLocation);
        }

        this.allInfos = infos;
        return infos;
    }

    public getAtIndex(index: number): GWeatherInfoData {
        if (this.selectedLocation) {
            if (index == 0) return this.selectedLocation;
            else index--;
        }
        if (this.currentLocationInfo) {
            if (index == 1) return this.currentLocationInfo;
            else index--;
        }

        return this.infoList[index];
    }

    public getCurrentLocation(): GWeatherInfoData | undefined {
        return this.currentLocationInfo;
    }

    public currentLocationChanged(location?: GWeather.Location): void {
        if (!location) return;

        const previous = this.currentLocationInfo;
        if (previous?.location.equal(location)) return;

        // Drop the old automatic entry unless the user also saved it.
        // (removeLocationInternal emits its own items_changed.)
        if (previous?._isCurrentLocation && previous !== this.selectedLocation)
            this.removeLocationInternal(previous);

        const oldLength = this.allInfos.length;
        this.currentLocationInfo = this.buildInfo(location);
        this.addCurrentLocation(this.currentLocationInfo);
        this.getAll();
        // @ts-expect-error ts-for-gir doesn't know how to handle interfaces
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        this.items_changed(0, oldLength, this.allInfos.length);
    }

    public getRecent(): GWeatherInfoData | undefined {
        if (this.infoList.length > 0) return this.infoList[0];
        else return undefined;
    }

    public load(): void {
        let locations: GLib.Variant[] = this.settings
            .get_value('locations')
            .deep_unpack();

        if (locations.length > 10) {
            locations = locations.slice(0, 10).filter(location => !!location);
            this.settings.set_value(
                'locations',
                new GLib.Variant('av', locations)
            );
        }

        let info = null;
        for (let i = locations.length - 1; i >= 0; i--) {
            const variant = locations[i];
            const location = this.world?.deserialize(variant);

            if (location) {
                info = this.addLocationInternal(location);
            }
        }

        if (info) {
            this.setSelectedLocation(info);
        }

        this.invalidate();
    }

    private invalidate(): void {
        this.getAll();
        // @ts-expect-error ts-for-gir doesn't know how to handle interfaces
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        this.items_changed(0, this.allInfos.length, this.allInfos.length);
    }

    private updateLoadingCount(delta: number): void {
        const wasLoading = this.loadingCount > 0;
        this.loadingCount += delta;
        const isLoading = this.loadingCount > 0;

        if (wasLoading != isLoading) this.notify('loading');
    }

    /**
     * Recreate every info with the current provider settings, keeping the
     * same locations, order, selection and current location.
     */
    public rebuildInfos(): void {
        const swap = (old?: GWeatherInfoData): GWeatherInfoData | undefined => {
            if (!old) return undefined;
            if (old._loadingId) {
                old.disconnect(old._loadingId);
                old._loadingId = 0;
                this.updateLoadingCount(-1);
            }
            const info = this.buildInfo(old.location);
            info._isCurrentLocation = old._isCurrentLocation;
            return info;
        };

        const mapping = new Map<GWeatherInfoData, GWeatherInfoData>();
        this.infoList = this.infoList.map(old => {
            const info = swap(old) ?? old;
            mapping.set(old, info);
            return info;
        });

        const remap = (old?: GWeatherInfoData): GWeatherInfoData | undefined =>
            old ? (mapping.get(old) ?? swap(old)) : undefined;
        this.currentLocationInfo = remap(this.currentLocationInfo);
        this.selectedLocation = remap(this.selectedLocation);

        for (const info of new Set([
            ...this.infoList,
            ...(this.currentLocationInfo ? [this.currentLocationInfo] : []),
            ...(this.selectedLocation ? [this.selectedLocation] : []),
        ]))
            this.updateInfo(info);

        const oldLength = this.allInfos.length;
        this.getAll();
        // @ts-expect-error ts-for-gir doesn't know how to handle interfaces
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        this.items_changed(0, oldLength, this.allInfos.length);

        if (this.selectedLocation)
            this.emit('selected-location-changed', this.selectedLocation);
    }

    public updateInfo(info: GWeatherInfoData): void {
        if (info._loadingId) return;

        info._loadingId = info.connect('updated', () => {
            if (info._loadingId) {
                info.disconnect(info._loadingId);
                info._loadingId = 0;
            }

            this.updateLoadingCount(-1);
        });

        info.update();
        this.updateLoadingCount(+1);
    }

    public get loading(): boolean {
        return this.loadingCount > 0;
    }

    public setSelectedLocation(info: WeatherInfo): void {
        const newInfo = this.addNewLocation(info.get_location());
        this.selectedLocation = newInfo;
        this.emit('selected-location-changed', info);
    }

    public isSelectedLocation(info: WeatherInfo): boolean {
        return !!this.selectedLocation && this.selectedLocation === info;
    }

    public isCurrentLocation(info: WeatherInfo): boolean {
        return !!this.currentLocationInfo && this.currentLocationInfo === info;
    }

    public addNewLocation(newLocation: GWeather.Location): GWeatherInfoData {
        const info: GWeatherInfoData = this.addLocationInternal(newLocation);
        this.selectedLocation = info;
        info._isCurrentLocation = false;

        this.invalidate();

        this.queueSaveSettings();
        return info;
    }

    private queueSaveSettings(): void {
        if (this.queueSaveSettingsId) return;

        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.queueSaveSettingsId = 0;
            this.saveSettingsInternal();
            return false;
        });
        this.queueSaveSettingsId = id;
    }

    private saveSettingsInternal(): void {
        const locations = [];

        for (const info of this.allInfos) {
            if (!info._isCurrentLocation) {
                let serialized = null;
                try {
                    serialized = info.location.serialize();
                } catch (error) {
                    console.error(error);
                }

                if (serialized) locations.push(serialized);
            }
        }

        this.settings.set_value('locations', new GLib.Variant('av', locations));
    }

    public saveSettingsNow(): void {
        if (!this.queueSaveSettingsId) return;

        GLib.source_remove(this.queueSaveSettingsId);
        this.queueSaveSettingsId = 0;

        this.saveSettingsInternal();
    }

    public addCurrentLocation(info: GWeatherInfoData): void {
        if (this.infoList.includes(info)) return;

        const existingInfo = this.infoList.find(i =>
            i.get_location().equal(info.location)
        );
        if (existingInfo) {
            this.currentLocationInfo = existingInfo;
            return;
        }

        info._isCurrentLocation = true;
        this.addInfoInternal(info);
    }

    public removeLocation(oldInfo?: GWeatherInfoData): void {
        this.removeLocationInternal(oldInfo);
    }

    private removeLocationInternal(oldInfo?: GWeatherInfoData): void {
        if (!oldInfo) return;

        if (oldInfo._loadingId) {
            oldInfo.disconnect(oldInfo._loadingId);
            oldInfo._loadingId = 0;
            this.updateLoadingCount(-1);
        }

        if (oldInfo == this.currentLocationInfo)
            this.currentLocationInfo = undefined;

        for (let i = 0; i < this.allInfos.length; i++) {
            if (this.allInfos[i] == oldInfo) {
                // @ts-expect-error ts-for-gir doesn't know how to handle interfaces
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                this.items_changed(i, 1, 0);
                break;
            }
        }
        for (let i = 0; i < this.infoList.length; i++) {
            if (this.infoList[i] == oldInfo) {
                this.infoList.splice(i, 1);
                break;
            }
        }

        this.getAll();
        this.queueSaveSettings();
    }

    public buildInfo(location: GWeather.Location): GWeatherInfoData {
        return Providers.buildInfo(this.settings, location);
    }

    private addLocationInternal(
        newLocation: GWeather.Location
    ): GWeatherInfoData {
        const existingInfo = this.infoList.find(info =>
            info.get_location().equal(newLocation)
        );
        if (existingInfo) return existingInfo;

        const info = this.buildInfo(newLocation);
        this.addInfoInternal(info);

        return info;
    }

    private addInfoInternal(info: WeatherInfo): void {
        this.infoList.unshift(info);
        this.updateInfo(info);

        if (this.infoList.length > 10) {
            const oldInfo = this.infoList.pop();
            if (oldInfo) {
                this.removeLocationInternal(oldInfo);
            }
        }
    }

    public vfunc_get_item_type(): GObject.GType {
        return WeatherInfo.$gtype;
    }

    public vfunc_get_n_items(): number {
        return this.allInfos.length;
    }

    public vfunc_get_item(n: number): GWeatherInfoData | undefined {
        return this.allInfos[n] ?? undefined;
    }
}
