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
import { getCrossTabSyncAdapter } from '@platform/cross-tab-sync-adapters';
import { getStorageAdapter } from '@platform/storage-adapters';

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;
  /** Callbacks notified when settings change from another tab. */
  private readonly onChangeCallbacks = new Set<() => void>();
  /** Guard: true during a save() call so cross-tab listeners can skip self-triggered events. */
  private saving = false;
  /** Debounce flag: true while a save is scheduled via requestIdleCallback. */
  private savePending = false;
  /** requestIdleCallback handle — stored so we can cancel on flush/destroy. */
  private saveIdleHandle = 0;
  /** Cross-tab sync adapter for the current environment. */
  private crossTabSyncAdapter = getCrossTabSyncAdapter(STORAGE_KEY);
  /** Bound callback reference for cross-tab sync adapter removeListener. */
  private readonly onCrossTabChange = (_key: string): void => {
    if (this.saving) return;
    log.debug('Cross-tab settings change detected via platform adapter');
    void this.reloadFromStorage();
  };

  constructor() {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
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

  async destroy(): Promise<void> {
    // Cancel any idle callback to avoid a race where flushSave() fires after destroy().
    if (this.saveIdleHandle !== 0) {
      cancelIdleCallback(this.saveIdleHandle);
      this.saveIdleHandle = 0;
    }
    // Await the flush to ensure the async save completes before tearing down.
    await this.flushSave();
    this.stopCrossTabSync();
    this.onChangeCallbacks.clear();
  }

  private startCrossTabSync(): void {
    this.crossTabSyncAdapter.addListener(this.onCrossTabChange);
  }

  private stopCrossTabSync(): void {
    this.crossTabSyncAdapter.removeListener();
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
      this.saving = true;
      const data = { ...this.settings, _version: SETTINGS_VERSION };
      await getStorageAdapter().setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error: unknown) {
      log.warn('Failed to save settings:', error);
    } finally {
      this.saving = false;
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
