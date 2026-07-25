// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import { getCrossTabSyncAdapter } from '@platform/cross-tab-sync-adapters';
import { getStorageAdapter } from '@platform/storage-adapters';
import {
  applySettingsPatch,
  cloneSettings,
  DEFAULT_SETTINGS,
  normalizeStoredSettings,
  SETTINGS_VERSION,
  STORAGE_KEY,
} from '@settings/schema';
import { createLogger } from '@util/logging';

const log = createLogger('Settings');

export class Settings {
  private settings: OverlaySettings;
  /** Callbacks notified when settings change from another tab. */
  private readonly onChangeCallbacks = new Set<() => void>();
  /** Guard: true during a save() call so cross-tab listeners can skip self-triggered events. */
  private saving = false;
  /** Debounce flag: true while a save is scheduled via requestIdleCallback. */
  private savePending = false;
  /** Monotonic local revision used to reject stale async cross-tab reloads. */
  private localRevision = 0;
  /** requestIdleCallback handle — stored so we can cancel on flush/destroy. */
  private saveIdleHandle = 0;
  /** setTimeout handle — used when requestIdleCallback is unavailable. */
  private saveTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /** Save currently awaiting an async storage adapter write. */
  private savePromise: Promise<void> | null = null;
  /** Cross-tab sync adapter for the current environment. */
  private crossTabSyncAdapter = getCrossTabSyncAdapter(STORAGE_KEY);
  /** Bound callback reference for cross-tab sync adapter removeListener. */
  private readonly onCrossTabChange = (_key: string): void => {
    // A remote event must never replace a local edit that is waiting for its
    // debounced save. The event may be delivered before our write completes.
    if (this.saving || this.savePending || this.savePromise) return;
    log.debug('settings.store.cross-tab-change');
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
        const parsed: unknown = JSON.parse(raw);
        // Guard: JSON.parse("null") → null, "42" → 42, "true" → true — none
        // are records. Only proceed if parsed is a non-null object.
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          this.settings = normalizeStoredSettings(parsed as Record<string, unknown>);
        }
      }
    } catch (error: unknown) {
      log.warn('settings.store.load-failed', { error: String(error) });
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
    // Remove cross-tab sync listener synchronously BEFORE awaiting the async
    // flushSave.  The adapter is a cached singleton shared by all Settings
    // instances — if a new instance calls startCrossTabSync() during the
    // await gap, this stale removeListener() would null out its callback.
    this.stopCrossTabSync();
    this.onChangeCallbacks.clear();

    // Cancel any idle callback / timeout to avoid a race where flushSave() fires after destroy().
    if (this.saveIdleHandle !== 0) {
      cancelIdleCallback(this.saveIdleHandle);
      this.saveIdleHandle = 0;
    }
    if (this.saveTimeoutHandle !== null) {
      clearTimeout(this.saveTimeoutHandle);
      this.saveTimeoutHandle = null;
    }
    await this.flushSave();
    // flushSave() is a no-op when the write already started and cleared the
    // pending flag. Wait for that in-flight write before another Settings
    // instance can read or overwrite the same storage key.
    if (this.savePromise) await this.savePromise;
  }

  private startCrossTabSync(): void {
    this.crossTabSyncAdapter.addListener(this.onCrossTabChange);
  }

  private stopCrossTabSync(): void {
    this.crossTabSyncAdapter.removeListener();
  }

  /** Reload settings from storage and notify subscribers. */
  private async reloadFromStorage(): Promise<void> {
    const revisionAtStart = this.localRevision;
    try {
      const adapter = getStorageAdapter();
      const raw = await adapter.getItem(STORAGE_KEY);
      if (!raw) return;
      // A local set/preview/reset may have happened while storage I/O was in
      // flight. Preserve that newer in-memory state instead of applying a
      // stale remote snapshot after the await.
      if (
        revisionAtStart !== this.localRevision ||
        this.savePending ||
        this.saving ||
        this.savePromise
      ) {
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const loaded = normalizeStoredSettings(parsed as Record<string, unknown>);
        this.settings = loaded;
        for (const cb of this.onChangeCallbacks) cb();
      }
    } catch (error: unknown) {
      log.warn('settings.store.reload-failed', { error: String(error) });
    }
  }

  private async save(): Promise<void> {
    try {
      this.saving = true;
      const data = { ...this.settings, _version: SETTINGS_VERSION };
      await getStorageAdapter().setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error: unknown) {
      log.warn('settings.store.save-failed', { error: String(error) });
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
      // No requestIdleCallback support — defer save to next task to avoid
      // racing with subsequent set() calls that update in-memory state first.
      this.saveTimeoutHandle = setTimeout(() => void this.flushSave(), 0);
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
    if (this.saveTimeoutHandle !== null) {
      clearTimeout(this.saveTimeoutHandle);
      this.saveTimeoutHandle = null;
    }
    // A new save may be scheduled while an async adapter write is still in
    // flight. Chain it behind the previous write so an older snapshot can
    // never complete after the newer one and overwrite it.
    const previousSave = this.savePromise;
    const savePromise = previousSave ? previousSave.then(() => this.save()) : this.save();
    this.savePromise = savePromise;
    try {
      await savePromise;
    } finally {
      if (this.savePromise === savePromise) this.savePromise = null;
    }
  }

  /**
   * Returns a deep clone of the current settings object.
   * Mutations to the returned object do not affect the stored settings.
   * Use set() or updateSettings() for persistent changes.
   */
  get(): Readonly<OverlaySettings> {
    return cloneSettings(this.settings);
  }

  /** Apply settings and persist to storage. */
  set(partial: Partial<OverlaySettings>): void {
    this.localRevision++;
    this.settings = applySettingsPatch(this.settings, partial);
    this.scheduleSave();
  }

  /** Apply settings to memory only (no storage write). Used for live preview. */
  preview(partial: Partial<OverlaySettings>): void {
    this.localRevision++;
    this.settings = applySettingsPatch(this.settings, partial);
  }

  /** Reset settings to factory defaults and persist. */
  reset(): void {
    this.localRevision++;
    this.settings = cloneSettings(DEFAULT_SETTINGS);
    this.scheduleSave();
    // Notify local subscribers (e.g., live UI) of the reset.
    // Without this, local listeners won't update until the next storage
    // write propagates through the cross-tab sync adapter.
    for (const cb of this.onChangeCallbacks) cb();
  }
}
