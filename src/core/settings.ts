import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';
import { overlayLog } from '@core/logging';
import { cloneSettings, mergeSettings, normalizeSettings } from '@core/settings-schema';
import { readStoredSettings, STORAGE_KEY } from '@core/settings-storage';

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = this.loadSettings();
  }

  private loadSettings(): OverlaySettings {
    try {
      const stored = readStoredSettings();
      if (stored) {
        return normalizeSettings(mergeSettings(DEFAULT_SETTINGS, stored));
      }
    } catch (error) {
      overlayLog.warn('[YT Chat Overlay] Failed to load settings:', error);
    }

    return cloneSettings(DEFAULT_SETTINGS);
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (error) {
      overlayLog.warn('[YT Chat Overlay] Failed to save settings:', error);
    }
  }

  get(): Readonly<OverlaySettings> {
    return cloneSettings(this.settings);
  }

  update(partial: Partial<OverlaySettings>): void {
    this.settings = normalizeSettings(mergeSettings(this.settings, partial));
    this.saveSettings();
  }
}
