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

const createGmAdapter = (): SettingsStorageAdapter | null => {
  if (typeof GM_setValue === 'undefined' || typeof GM_getValue === 'undefined') {
    return null;
  }

  return {
    getItem(key: string): string | null {
      const value = GM_getValue(key);
      if (value === undefined || value === null) return null;
      return String(value);
    },
    setItem(key: string, value: string): void {
      GM_setValue(key, value);
    },
  };
};

let cachedAdapter: SettingsStorageAdapter | null = null;

export function getSettingsStorageAdapter(): SettingsStorageAdapter {
  if (cachedAdapter) return cachedAdapter;
  cachedAdapter = createGmAdapter() ?? new LocalStorageAdapter();
  return cachedAdapter;
}
