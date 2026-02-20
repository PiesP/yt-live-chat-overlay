/**
 * Settings Manager
 *
 * Manages user settings with localStorage persistence.
 * Only settings are stored - no chat data.
 */

import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';

const STORAGE_KEY = 'yt-live-chat-overlay-settings';

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
        const parsedRaw = JSON.parse(stored) as Partial<OverlaySettings> & {
          debugLogging?: boolean;
        };
        const { debugLogging, ...parsed } = parsedRaw;
        const migratedLogLevel = parsed.logLevel ?? (debugLogging ? 'debug' : undefined);

        // Merge with defaults to ensure new fields (like colors) are included
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          ...(migratedLogLevel ? { logLevel: migratedLogLevel } : {}),
          // Deep merge colors to ensure all color fields are present
          colors: {
            ...DEFAULT_SETTINGS.colors,
            ...(parsed.colors || {}),
          },
          // Deep merge outline to ensure all fields are present
          outline: {
            ...DEFAULT_SETTINGS.outline,
            ...(parsed.outline || {}),
          },
        };
      }
    } catch (error) {
      console.warn('[YT Chat Overlay] Failed to load settings:', error);
    }
    return { ...DEFAULT_SETTINGS };
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
    return { ...this.settings };
  }

  /**
   * Update settings
   */
  update(partial: Partial<OverlaySettings>): void {
    this.settings = {
      ...this.settings,
      ...partial,
      colors: partial.colors
        ? { ...this.settings.colors, ...partial.colors }
        : this.settings.colors,
      outline: partial.outline
        ? { ...this.settings.outline, ...partial.outline }
        : this.settings.outline,
    };
    this.saveSettings();
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.saveSettings();
  }
}
