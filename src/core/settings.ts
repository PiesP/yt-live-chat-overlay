import type { OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import { DEFAULT_SETTINGS, STORAGE_KEY } from '@core/settings-definitions';
import { applySettingsPatch, cloneSettings, normalizeStoredSettings } from '@core/settings-schema';
import { getSettingsStorageAdapter } from '@core/settings-storage';

const log = createLogger('Settings');

function readStoredRaw(): Record<string, unknown> | null {
  try {
    const raw = getSettingsStorageAdapter().getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      '__proto__' in parsed ||
      'constructor' in parsed
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = this.load();
  }

  private load(): OverlaySettings {
    try {
      return normalizeStoredSettings(readStoredRaw());
    } catch (error) {
      log.warn('Failed to load settings:', error);
      return cloneSettings(DEFAULT_SETTINGS);
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
