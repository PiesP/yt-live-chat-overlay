import { isLogLevel, type OverlaySettings } from '@app-types';
import { DEFAULT_SETTINGS } from '@core/settings-definitions';

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

export type StoredSettings = Partial<OverlaySettings>;

export const readStoredSettings = (): StoredSettings | null => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return null;
  }

  return JSON.parse(stored) as StoredSettings;
};

export const writeStoredSettings = (settings: Readonly<OverlaySettings>): void => {
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
