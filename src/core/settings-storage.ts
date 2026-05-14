/**
 * Storage adapter for settings persistence.
 *
 * Uses Tampermonkey GM_setValue/GM_getValue when available,
 * otherwise falls back to localStorage.
 */

export interface SettingsStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

class LocalStorageAdapter implements SettingsStorageAdapter {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // quota exceeded or private browsing — silently ignore
    }
  }
}

const gmAdapter = (): SettingsStorageAdapter | null => {
  const gmSetValue = typeof GM_setValue !== 'undefined' ? GM_setValue : undefined;
  const gmGetValue = typeof GM_getValue !== 'undefined' ? GM_getValue : undefined;

  if (!gmSetValue || !gmGetValue) return null;

  return {
    getItem(key: string): string | null {
      const value = gmGetValue(key);
      if (value === undefined || value === null || value === '') return null;
      return value;
    },
    setItem(key: string, value: string): void {
      gmSetValue(key, value);
    },
  };
};

let cachedAdapter: SettingsStorageAdapter | null = null;

export function getSettingsStorageAdapter(): SettingsStorageAdapter {
  if (cachedAdapter) return cachedAdapter;
  cachedAdapter = gmAdapter() ?? new LocalStorageAdapter();
  return cachedAdapter;
}
