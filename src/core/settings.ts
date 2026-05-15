import type { OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import {
  applySettingsPatch,
  cloneSettings,
  DEFAULT_SETTINGS,
  normalizeStoredSettings,
  STORAGE_KEY,
} from '@core/settings-schema';
import { getSettingsStorageAdapter } from '@core/settings-storage';

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
  }

  initialize(): void {
    try {
      const adapter = getSettingsStorageAdapter();
      const raw = adapter.getItem(STORAGE_KEY);
      if (raw) {
        this.settings = normalizeStoredSettings(JSON.parse(raw) as Record<string, unknown>);
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

  /** Apply settings and persist to storage. */
  set(partial: Partial<OverlaySettings>): void {
    this.settings = applySettingsPatch(this.settings, partial);
    this.save();
  }

  /** Apply settings to memory only (no storage write). Used for live preview. */
  preview(partial: Partial<OverlaySettings>): void {
    this.settings = applySettingsPatch(this.settings, partial);
  }
}
