import type { OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import { DEFAULT_SETTINGS, STORAGE_KEY } from '@core/settings-definitions';
import { applySettingsPatch, cloneSettings, normalizeStoredSettings } from '@core/settings-schema';
import { getSettingsStorageAdapter } from '@core/settings-storage';

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
  }

  initialize(): void {
    console.warn('[Settings::diagnostic] GM_setValue:', typeof GM_setValue);
    console.warn('[Settings::diagnostic] GM_getValue:', typeof GM_getValue);
    console.warn('[Settings::diagnostic] GM_deleteValue:', typeof GM_deleteValue);
    try {
      const adapter = getSettingsStorageAdapter();
      const raw = adapter.getItem(STORAGE_KEY);
      console.warn('[Settings::diagnostic] raw from storage:', raw);
      if (raw) {
        const parsed = normalizeStoredSettings(JSON.parse(raw) as Record<string, unknown>);
        console.warn('[Settings::diagnostic] loaded fontSize:', parsed.fontSize);
        console.warn('[Settings::diagnostic] loaded rendererType:', parsed.rendererType);
        this.settings = parsed;
      } else {
        console.warn('[Settings::diagnostic] no stored data, using defaults');
      }
    } catch (error) {
      log.warn('Failed to load settings:', error);
    }
  }

  private save(): void {
    try {
      getSettingsStorageAdapter().setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (error) {
      log.warn('Failed to save settings:', error);
    }
  }

  get(): Readonly<OverlaySettings> {
    return this.settings;
  }

  set(partial: Partial<OverlaySettings>): void {
    this.settings = applySettingsPatch(this.settings, partial);
    this.save();
  }
}
