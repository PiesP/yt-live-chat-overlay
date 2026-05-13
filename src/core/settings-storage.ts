/**
 * Storage adapter for settings persistence.
 *
 * Uses Tampermonkey GM_setValue/GM_getValue when available,
 * otherwise falls back to localStorage.
 */

export interface SettingsStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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

  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // silently ignore
    }
  }
}

const gmAdapter = (): SettingsStorageAdapter | null => {
  if (typeof GM_setValue === 'undefined' || typeof GM_getValue === 'undefined') {
    return null;
  }
  return {
    getItem(key: string): string | null {
      const value = GM_getValue(key);
      return value !== '' ? value : null;
    },
    setItem(key: string, value: string): void {
      GM_setValue(key, value);
    },
    removeItem(key: string): void {
      GM_setValue(key, '');
    },
  };
};

let cachedAdapter: SettingsStorageAdapter | null = null;

export function getSettingsStorageAdapter(): SettingsStorageAdapter {
  if (cachedAdapter) return cachedAdapter;
  cachedAdapter = gmAdapter() ?? new LocalStorageAdapter();
  return cachedAdapter;
}
