import { DEFAULT_SETTINGS, isLogLevel, type OverlaySettings } from '@app-types';

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

export interface StoredSettings extends Partial<OverlaySettings> {
  debugLogging?: boolean;
}

export const readStoredSettings = (): StoredSettings | null => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return null;
  }

  return JSON.parse(stored) as StoredSettings;
};

export const resolveStoredLogLevel = (
  stored: Pick<StoredSettings, 'logLevel' | 'debugLogging'>
): OverlaySettings['logLevel'] | undefined => {
  if (isLogLevel(stored.logLevel)) {
    return stored.logLevel;
  }

  return stored.debugLogging ? 'debug' : undefined;
};

export const readStoredLogLevel = (): OverlaySettings['logLevel'] => {
  try {
    const stored = readStoredSettings();
    if (!stored) {
      return DEFAULT_SETTINGS.logLevel;
    }

    return resolveStoredLogLevel(stored) ?? DEFAULT_SETTINGS.logLevel;
  } catch {
    return DEFAULT_SETTINGS.logLevel;
  }
};
