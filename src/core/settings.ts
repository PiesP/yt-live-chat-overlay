// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

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
import { getStorageAdapter } from '@platform/storage-adapters';

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;
  /** Callbacks notified when settings change from another tab. */
  private readonly onChangeCallbacks = new Set<() => void>();
  /** Guard: prevents self-triggered GM listener from re-applying our own save.
   *  Incremented on every save(); the listener captures the pre-save generation
   *  and skips reload if it matches, handling both sync and async listener timing. */
  private saveGeneration = 0;
  /** Tracks the saveGeneration value at the last self-initiated save.
   *  GM listener skips reload when current saveGeneration matches this. */
  private lastSelfSaveGeneration = 0;
  /** Debounce flag: true while a save is scheduled via requestIdleCallback. */
  private savePending = false;
  /** requestIdleCallback handle — stored so we can cancel on flush/destroy. */
  private saveIdleHandle = 0;
  /** GM value change listener ID, for cleanup. */
  private gmListenerId: number | null = null;
  /** chrome.storage.onChanged listener reference, for cleanup. */
  private chromeStorageListener:
    | ((changes: Record<string, unknown>, areaName: string) => void)
    | null = null;
  /** Bound storage event handler reference, for cleanup. */
  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    log.debug('Cross-tab settings change detected via storage event');
    void this.reloadFromStorage();
  };

  constructor() {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
  }

  /** Whether chrome.storage.onChanged is available (extension context). */
  private static get hasChromeStorageEvents(): boolean {
    return (
      typeof chrome !== 'undefined' &&
      chrome.storage !== undefined &&
      chrome.storage.onChanged !== undefined
    );
  }

  /** Whether GM_addValueChangeListener is available (userscript context). */
  private static get hasGmValueChangeListener(): boolean {
    return typeof GM_addValueChangeListener !== 'undefined';
  }

  async initialize(): Promise<void> {
    try {
      const adapter = getStorageAdapter();
      const raw = await adapter.getItem(STORAGE_KEY);
      if (raw) {
        this.settings = normalizeStoredSettings(JSON.parse(raw) as Record<string, unknown>);
      }
    } catch (error: unknown) {
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
    this.flushSave();
    if (this.saveIdleHandle !== 0) {
      cancelIdleCallback(this.saveIdleHandle);
      this.saveIdleHandle = 0;
    }
    this.stopCrossTabSync();
    this.onChangeCallbacks.clear();
  }

  private startCrossTabSync(): void {
    // localStorage path: fires in other tabs when setItem() is called.
    // This is the primary cross-tab sync mechanism for MAIN-world content
    // scripts where chrome.storage.onChanged is not available.
    window.addEventListener('storage', this.handleStorageEvent);

    // GM storage path: fires in all tabs (including the caller).
    // Only available in userscript contexts (Tampermonkey/Violentmonkey).
    if (Settings.hasGmValueChangeListener) {
      this.gmListenerId = GM_addValueChangeListener(STORAGE_KEY, () => {
        // Skip self-triggered events: if our last save matches current generation,
        // this event was triggered by our own save and we should not reload.
        if (this.saveGeneration === this.lastSelfSaveGeneration) return;
        log.debug('Cross-tab settings change detected via GM listener');
        void this.reloadFromStorage();
      });
    }

    // Chrome extension storage path: fires when chrome.storage.local changes.
    // NOTE: This is NOT available in MAIN-world content scripts (world: "MAIN").
    // In that context, ChromeStorageAdapter.isAvailable() returns false and
    // the adapter falls back to LocalStorageAdapter, which relies on the
    // 'storage' event listener registered above.
    if (Settings.hasChromeStorageEvents) {
      this.chromeStorageListener = (changes: Record<string, unknown>, areaName: string) => {
        if (areaName !== 'local') return;
        const change = changes[STORAGE_KEY] as { newValue?: unknown } | undefined;
        if (!change) return;
        log.debug('Cross-tab settings change detected via chrome.storage.onChanged');
        void this.reloadFromStorage();
      };
      chrome?.storage?.onChanged.addListener(this.chromeStorageListener);
    }
  }

  private stopCrossTabSync(): void {
    window.removeEventListener('storage', this.handleStorageEvent);
    if (this.gmListenerId !== null && Settings.hasGmValueChangeListener) {
      GM_removeValueChangeListener(this.gmListenerId);
      this.gmListenerId = null;
    }
    if (this.chromeStorageListener !== null && Settings.hasChromeStorageEvents) {
      chrome?.storage?.onChanged.removeListener(this.chromeStorageListener);
      this.chromeStorageListener = null;
    }
  }

  /** Reload settings from storage and notify subscribers. */
  private async reloadFromStorage(): Promise<void> {
    try {
      const adapter = getStorageAdapter();
      const raw = await adapter.getItem(STORAGE_KEY);
      if (!raw) return;
      const loaded = normalizeStoredSettings(JSON.parse(raw) as Record<string, unknown>);
      this.settings = loaded;
      for (const cb of this.onChangeCallbacks) cb();
    } catch (error: unknown) {
      log.warn('Failed to reload settings from storage:', error);
    }
  }

  private async save(): Promise<void> {
    try {
      this.saveGeneration++;
      this.lastSelfSaveGeneration = this.saveGeneration;
      const data = { ...this.settings, _version: SETTINGS_VERSION };
      await getStorageAdapter().setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error: unknown) {
      log.warn('Failed to save settings:', error);
    }
  }

  /**
   * Schedule a debounced save via requestIdleCallback.
   * Multiple calls within the same frame are coalesced into a single write.
   */
  private scheduleSave(): void {
    if (this.savePending) return;
    this.savePending = true;
    if (typeof requestIdleCallback !== 'undefined') {
      this.saveIdleHandle = requestIdleCallback(() => void this.flushSave(), { timeout: 2000 });
    } else {
      // No requestIdleCallback support — save immediately.
      void this.flushSave();
    }
  }

  /** Flush any pending debounced save immediately. */
  private async flushSave(): Promise<void> {
    if (!this.savePending) return;
    this.savePending = false;
    if (this.saveIdleHandle !== 0) {
      cancelIdleCallback(this.saveIdleHandle);
      this.saveIdleHandle = 0;
    }
    await this.save();
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
    this.scheduleSave();
  }

  /** Apply settings to memory only (no storage write). Used for live preview. */
  preview(partial: Partial<OverlaySettings>): void {
    this.settings = applySettingsPatch(this.settings, partial);
  }

  /** Reset settings to factory defaults and persist. */
  reset(): void {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
    this.scheduleSave();
  }
}
