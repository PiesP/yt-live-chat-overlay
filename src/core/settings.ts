import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import { applySettings, cloneSettings } from '@core/settings-schema';
import { readStoredSettings, STORAGE_KEY } from '@core/settings-storage';

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = this.loadSettings();
  }

  private loadSettings(): OverlaySettings {
    try {
      const stored = readStoredSettings();
      if (stored) {
        return applySettings(DEFAULT_SETTINGS, stored);
      }
    } catch (error) {
      log.warn('Failed to load settings:', error);
    }

    return cloneSettings(DEFAULT_SETTINGS);
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (error) {
      log.warn('Failed to save settings:', error);
    }
  }

  get(): Readonly<OverlaySettings> {
    return cloneSettings(this.settings);
  }

  update(partial: Partial<OverlaySettings>): void {
    this.settings = applySettings(this.settings, partial);
    this.saveSettings();
  }
}
