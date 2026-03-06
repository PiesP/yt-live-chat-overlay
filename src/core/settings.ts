/**
 * Settings Manager
 *
 * Manages user settings with localStorage persistence.
 * Only settings are stored - no chat data.
 */

import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';

const STORAGE_KEY = 'yt-live-chat-overlay-settings';

interface StoredSettings extends Partial<OverlaySettings> {
  debugLogging?: boolean;
}

const cloneSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  ...settings,
  showAuthor: { ...settings.showAuthor },
  colors: { ...settings.colors },
  outline: { ...settings.outline },
});

const mergeSettings = (
  base: Readonly<OverlaySettings>,
  partial: Partial<OverlaySettings>
): OverlaySettings => ({
  ...base,
  ...partial,
  showAuthor: partial.showAuthor
    ? { ...base.showAuthor, ...partial.showAuthor }
    : { ...base.showAuthor },
  colors: partial.colors ? { ...base.colors, ...partial.colors } : { ...base.colors },
  outline: partial.outline ? { ...base.outline, ...partial.outline } : { ...base.outline },
});

const normalizeStoredSettings = (stored: StoredSettings): OverlaySettings => {
  const { debugLogging, ...parsed } = stored;
  const migratedLogLevel = parsed.logLevel ?? (debugLogging ? 'debug' : undefined);

  return mergeSettings(DEFAULT_SETTINGS, {
    ...parsed,
    ...(migratedLogLevel ? { logLevel: migratedLogLevel } : {}),
  });
};

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from localStorage
   */
  private loadSettings(): OverlaySettings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return normalizeStoredSettings(JSON.parse(stored) as StoredSettings);
      }
    } catch (error) {
      console.warn('[YT Chat Overlay] Failed to load settings:', error);
    }

    return cloneSettings(DEFAULT_SETTINGS);
  }

  /**
   * Save settings to localStorage
   */
  private saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (error) {
      console.warn('[YT Chat Overlay] Failed to save settings:', error);
    }
  }

  /**
   * Get current settings
   */
  get(): Readonly<OverlaySettings> {
    return cloneSettings(this.settings);
  }

  /**
   * Update settings
   */
  update(partial: Partial<OverlaySettings>): void {
    this.settings = mergeSettings(this.settings, partial);
    this.saveSettings();
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
    this.saveSettings();
  }
}
