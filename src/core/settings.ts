import { isLogLevel, type OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import { DEFAULT_SETTINGS } from '@core/settings-definitions';
import { applySettingsPatch, cloneSettings, normalizeStoredSettings } from '@core/settings-schema';

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

type StoredSettings = Partial<OverlaySettings>;

const readStoredSettings = (): StoredSettings | null => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return null;
  }

  return JSON.parse(stored) as StoredSettings;
};

const writeStoredSettings = (settings: Readonly<OverlaySettings>): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

export const readStoredLogLevel = (): OverlaySettings['logLevel'] => {
  try {
    const stored = readStoredSettings();
    if (stored && isLogLevel(stored.logLevel)) {
      return stored.logLevel;
    }
  } catch {
    // fall through to default
  }

  return DEFAULT_SETTINGS.logLevel;
};

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = this.loadSettings();
  }

  private loadSettings(): OverlaySettings {
    try {
      return normalizeStoredSettings(readStoredSettings());
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
