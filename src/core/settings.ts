import type { OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import { DEFAULT_SETTINGS, readStoredSettingsRaw, STORAGE_KEY } from '@core/settings-definitions';
import { applySettingsPatch, cloneSettings, normalizeStoredSettings } from '@core/settings-schema';

const writeStoredSettings = (settings: Readonly<OverlaySettings>): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = this.loadSettings();
  }

  private loadSettings(): OverlaySettings {
    try {
      return normalizeStoredSettings(readStoredSettingsRaw());
    } catch (error) {
      log.warn('Failed to load settings:', error);
      return cloneSettings(DEFAULT_SETTINGS);
    }
  }

  private saveSettings(): void {
    try {
      writeStoredSettings(this.settings);
    } catch (error) {
      log.warn('Failed to save settings:', error);
    }
  }

  get(): Readonly<OverlaySettings> {
    return this.settings;
  }

  update(partial: Partial<OverlaySettings>): void {
    this.settings = applySettingsPatch(this.settings, partial);
    this.saveSettings();
  }
}
