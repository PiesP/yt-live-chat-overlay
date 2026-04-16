/**
 * Settings Manager
 *
 * Manages user settings with localStorage persistence.
 * Only settings are stored - no chat data.
 */

import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';
import { overlayLog } from '@core/logging';
import { cloneSettings, mergeSettings, normalizeSettings } from '@core/settings-schema';
import {
  readStoredSettings,
  resolveStoredLogLevel,
  STORAGE_KEY,
  type StoredSettings,
} from '@core/settings-storage';

const normalizeStoredSettings = (stored: StoredSettings): OverlaySettings => {
  const { debugLogging: _legacyDebugLogging, ...parsed } = stored;
  const migratedLogLevel = resolveStoredLogLevel(stored);

  return normalizeSettings(
    mergeSettings(DEFAULT_SETTINGS, {
      ...parsed,
      ...(migratedLogLevel ? { logLevel: migratedLogLevel } : {}),
    })
  );
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
      const stored = readStoredSettings();
      if (stored) {
        return normalizeStoredSettings(stored);
      }
    } catch (error) {
      overlayLog.warn('[YT Chat Overlay] Failed to load settings:', error);
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
      overlayLog.warn('[YT Chat Overlay] Failed to save settings:', error);
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
    this.settings = normalizeSettings(mergeSettings(this.settings, partial));
    this.saveSettings();
  }
}
