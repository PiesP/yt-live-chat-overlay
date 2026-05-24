import type { OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import {
  applySettingsPatch,
  cloneSettings,
  DEFAULT_SETTINGS,
  normalizeStoredSettings,
  SETTINGS_VERSION,
  STORAGE_KEY,
} from '@core/settings-schema';
import { getSettingsStorageAdapter } from '@core/settings-storage';

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;
  /** Callbacks notified when settings change from another tab. */
  private readonly onChangeCallbacks = new Set<() => void>();
  /** Guard: prevents self-triggered GM listener from re-applying our own save. */
  private isSaving = false;
  /** GM value change listener ID, for cleanup. */
  private gmListenerId: number | null = null;
  /** Bound storage event handler reference, for cleanup. */
  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    log.debug('Cross-tab settings change detected via storage event');
    this.reloadFromStorage();
  };

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

    this.startCrossTabSync();
  }

  /** Subscribe to cross-tab settings changes. Returns an unsubscribe function. */
  subscribe(callback: () => void): () => void {
    this.onChangeCallbacks.add(callback);
    return () => {
      this.onChangeCallbacks.delete(callback);
    };
  }

  destroy(): void {
    this.stopCrossTabSync();
    this.onChangeCallbacks.clear();
  }

  private startCrossTabSync(): void {
    // localStorage path: fires in other tabs when setItem() is called
    window.addEventListener('storage', this.handleStorageEvent);

    // GM storage path: fires in all tabs (including the caller)
    if (typeof GM_addValueChangeListener !== 'undefined') {
      this.gmListenerId = GM_addValueChangeListener(STORAGE_KEY, () => {
        // Skip self-triggered events: set() already applied the change,
        // so reloading would be a no-op at best, or could reset dirty preview state.
        if (this.isSaving) return;
        log.debug('Cross-tab settings change detected via GM listener');
        this.reloadFromStorage();
      });
    }
  }

  private stopCrossTabSync(): void {
    window.removeEventListener('storage', this.handleStorageEvent);
    if (this.gmListenerId !== null && typeof GM_removeValueChangeListener !== 'undefined') {
      GM_removeValueChangeListener(this.gmListenerId);
      this.gmListenerId = null;
    }
  }

  /** Reload settings from storage and notify subscribers. */
  private reloadFromStorage(): void {
    try {
      const adapter = getSettingsStorageAdapter();
      const raw = adapter.getItem(STORAGE_KEY);
      if (!raw) return;
      const loaded = normalizeStoredSettings(JSON.parse(raw) as Record<string, unknown>);
      this.settings = loaded;
      for (const cb of this.onChangeCallbacks) cb();
    } catch (error) {
      log.warn('Failed to reload settings from storage:', error);
    }
  }

  private save(): void {
    try {
      this.isSaving = true;
      const data = { ...this.settings, _version: SETTINGS_VERSION };
      getSettingsStorageAdapter().setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      log.warn('Failed to save settings:', error);
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Returns the current settings object. Do NOT modify the returned object
   * directly — use updateSettings() for mutations.
   */
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
