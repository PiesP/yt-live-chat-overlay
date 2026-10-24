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

export type PersistenceState = 'saved' | 'pending' | 'unsaved' | 'conflict';

type UnsavedSnapshot = { revision: number; settings: OverlaySettings };
type Handoff = {
  owner: symbol;
  revision: number;
  settings: OverlaySettings;
  baselineRaw: string | null;
  conflicted: boolean;
};

// A replacement App can start before its predecessor's async write finishes.
// The queue keeps writes ordered across Settings owners in the same document;
// the handoff retains an unsaved choice across an in-document restart only.
let activeOwner: symbol | null = null;
let writeTail: Promise<void> = Promise.resolve();
let pendingHandoff: Handoff | null = null;

function serialized(settings: OverlaySettings): string {
  return JSON.stringify({ ...settings, _version: SETTINGS_VERSION });
}

export class Settings {
  private readonly owner = Symbol('settings-owner');
  private settings = cloneSettings(DEFAULT_SETTINGS);
  private readonly onChangeCallbacks = new Set<() => void>();
  private readonly onPersistenceCallbacks = new Set<(state: PersistenceState) => void>();
  private saving = false;
  /** Scheduling is distinct from whether the latest intended value was saved. */
  private savePending = false;
  private localRevision = 0;
  private previewDirty = false;
  private unsaved: UnsavedSnapshot | null = null;
  private writeFailed = false;
  private remoteConflict = false;
  private conflictEpoch = 0;
  private lastStoredRaw: string | null = null;
  private inFlightRaw: string | null = null;
  private retired = false;
  private saveIdleHandle = 0;
  private saveTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private savePromise: Promise<PersistenceState> | null = null;
  private crossTabSyncAdapter = getCrossTabSyncAdapter(STORAGE_KEY);
  private readonly onCrossTabChange = (_key: string, newValue: unknown): void => {
    if (this.retired || activeOwner !== this.owner) return;
    const changedRaw =
      typeof newValue === 'string' ? newValue : newValue == null ? null : JSON.stringify(newValue);
    if (
      (this.inFlightRaw !== null && changedRaw === this.inFlightRaw) ||
      (changedRaw === this.lastStoredRaw && !this.saving)
    )
      return;
    if (this.unsaved || this.previewDirty || this.saving || this.savePromise) {
      // A remote decision cannot silently replace this local edit, and an
      // automatic retry cannot silently replace the remote decision.
      if (!this.unsaved) {
        this.localRevision++;
        this.unsaved = { revision: this.localRevision, settings: cloneSettings(this.settings) };
        pendingHandoff = {
          owner: this.owner,
          revision: this.localRevision,
          settings: cloneSettings(this.settings),
          baselineRaw: this.lastStoredRaw,
          conflicted: true,
        };
      }
      this.remoteConflict = true;
      this.conflictEpoch++;
      if (pendingHandoff?.owner === this.owner) pendingHandoff.conflicted = true;
      this.notifyPersistence();
      return;
    }
    log.debug('settings.store.cross-tab-change');
    void this.reloadFromStorage();
  };

  constructor() {
    activeOwner = this.owner;
  }

  async initialize(): Promise<void> {
    // A previous owner may already have started a write. Observe its final
    // storage state before applying the in-document handoff.
    await writeTail;
    if (this.retired || activeOwner !== this.owner) return;
    try {
      const raw = await getStorageAdapter().getItem(STORAGE_KEY);
      if (this.retired || activeOwner !== this.owner) return;
      const handoff = pendingHandoff;
      if (handoff) {
        this.settings = cloneSettings(handoff.settings);
        if (raw === serialized(handoff.settings) && !handoff.conflicted) {
          pendingHandoff = null;
          this.lastStoredRaw = raw;
        } else {
          this.localRevision++;
          this.unsaved = {
            revision: this.localRevision,
            settings: cloneSettings(handoff.settings),
          };
          this.lastStoredRaw = handoff.baselineRaw;
          this.remoteConflict = handoff.conflicted || raw !== handoff.baselineRaw;
          this.writeFailed = !this.remoteConflict;
          pendingHandoff = { ...handoff, owner: this.owner, revision: this.localRevision };
        }
      } else {
        this.lastStoredRaw = raw;
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            this.settings = normalizeStoredSettings(parsed as Record<string, unknown>);
          }
        }
      }
    } catch (error: unknown) {
      log.warn('settings.store.load-failed', { error: String(error) });
      if (pendingHandoff) {
        this.settings = cloneSettings(pendingHandoff.settings);
        this.localRevision++;
        this.unsaved = { revision: this.localRevision, settings: cloneSettings(this.settings) };
        this.writeFailed = true;
        pendingHandoff = { ...pendingHandoff, owner: this.owner, revision: this.localRevision };
      }
    }
    if (this.retired || activeOwner !== this.owner) return;
    this.crossTabSyncAdapter.addListener(this.onCrossTabChange);
    this.notifyPersistence();
  }

  subscribe(callback: () => void): () => void {
    this.onChangeCallbacks.add(callback);
    return () => this.onChangeCallbacks.delete(callback);
  }

  subscribePersistence(callback: (state: PersistenceState) => void): () => void {
    this.onPersistenceCallbacks.add(callback);
    callback(this.persistenceState());
    return () => this.onPersistenceCallbacks.delete(callback);
  }

  persistenceState(): PersistenceState {
    if (this.remoteConflict) return 'conflict';
    if (this.saving || this.savePromise) return 'pending';
    return this.settledState();
  }

  private settledState(): PersistenceState {
    if (this.remoteConflict) return 'conflict';
    if (this.writeFailed) return 'unsaved';
    return this.unsaved ? 'pending' : 'saved';
  }

  private notifyPersistence(): void {
    const state = this.persistenceState();
    for (const callback of this.onPersistenceCallbacks) callback(state);
  }

  async destroy(): Promise<void> {
    // The adapter is shared. A retired owner must not remove a replacement's
    // listener after that replacement has registered it.
    if (activeOwner === this.owner) this.crossTabSyncAdapter.removeListener();
    this.onChangeCallbacks.clear();
    this.onPersistenceCallbacks.clear();
    this.cancelScheduledSave();
    if (this.savePending && !this.remoteConflict && activeOwner === this.owner) {
      await this.flushSave();
    }
    if (this.savePromise) await this.savePromise;
    this.retired = true;
    if (activeOwner === this.owner) activeOwner = null;
  }

  private async reloadFromStorage(): Promise<void> {
    const revisionAtStart = this.localRevision;
    try {
      const raw = await getStorageAdapter().getItem(STORAGE_KEY);
      if (!raw || this.retired || activeOwner !== this.owner) return;
      if (
        revisionAtStart !== this.localRevision ||
        this.unsaved ||
        this.previewDirty ||
        this.saving ||
        this.savePromise
      )
        return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        this.settings = normalizeStoredSettings(parsed as Record<string, unknown>);
        this.lastStoredRaw = raw;
        for (const cb of this.onChangeCallbacks) cb();
      }
    } catch (error: unknown) {
      log.warn('settings.store.reload-failed', { error: String(error) });
    }
  }

  private async writeUnsaved(): Promise<PersistenceState> {
    const previous = writeTail;
    let release: () => void = () => {};
    writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.retired || activeOwner !== this.owner || this.remoteConflict || !this.unsaved) {
        return this.persistenceState();
      }
      const snapshot = this.unsaved;
      const raw = serialized(snapshot.settings);
      const startedConflictEpoch = this.conflictEpoch;
      this.saving = true;
      this.inFlightRaw = raw;
      try {
        await getStorageAdapter().setItem(STORAGE_KEY, raw);
        this.lastStoredRaw = raw;
        if (
          !this.remoteConflict &&
          this.conflictEpoch === startedConflictEpoch &&
          this.unsaved?.revision === snapshot.revision
        ) {
          this.unsaved = null;
          this.writeFailed = false;
          if (
            pendingHandoff?.owner === this.owner &&
            pendingHandoff.revision === snapshot.revision
          ) {
            pendingHandoff = null;
          }
        } else if (pendingHandoff?.owner === this.owner) {
          pendingHandoff.baselineRaw = raw;
        }
      } catch (error: unknown) {
        this.writeFailed = true;
        log.warn('settings.store.save-failed', { error: String(error) });
      } finally {
        this.saving = false;
        this.inFlightRaw = null;
      }
      return this.settledState();
    } finally {
      release();
    }
  }

  private cancelScheduledSave(): void {
    if (this.saveIdleHandle !== 0) {
      cancelIdleCallback(this.saveIdleHandle);
      this.saveIdleHandle = 0;
    }
    if (this.saveTimeoutHandle !== null) {
      clearTimeout(this.saveTimeoutHandle);
      this.saveTimeoutHandle = null;
    }
  }

  private scheduleSave(): void {
    if (this.retired || activeOwner !== this.owner || this.savePending) return;
    this.savePending = true;
    if (typeof requestIdleCallback !== 'undefined') {
      this.saveIdleHandle = requestIdleCallback(() => void this.flushSave(), { timeout: 2000 });
    } else {
      this.saveTimeoutHandle = setTimeout(() => void this.flushSave(), 0);
    }
  }

  private async flushSave(force = false, newChoice = false): Promise<PersistenceState> {
    if (force && !newChoice && !this.savePending && this.savePromise) return this.savePromise;
    if ((!this.savePending && !force) || this.remoteConflict || !this.unsaved) {
      return this.savePromise ?? this.persistenceState();
    }
    this.savePending = false;
    this.cancelScheduledSave();
    const previousSave = this.savePromise;
    const savePromise = previousSave
      ? previousSave.then(() => this.writeUnsaved())
      : this.writeUnsaved();
    this.savePromise = savePromise;
    try {
      return await savePromise;
    } finally {
      if (this.savePromise === savePromise) this.savePromise = null;
      this.notifyPersistence();
    }
  }

  /** Complete a user-initiated save without holding the dialog open. */
  persistNow(): Promise<PersistenceState> {
    return this.flushSave(true);
  }

  /** Exactly one manual attempt; a denial never starts a retry timer. */
  retrySave(): Promise<PersistenceState> {
    return this.flushSave(true);
  }

  get(): Readonly<OverlaySettings> {
    return cloneSettings(this.settings);
  }

  set(partial: Partial<OverlaySettings>): void {
    if (this.retired || activeOwner !== this.owner) return;
    this.localRevision++;
    this.settings = applySettingsPatch(this.settings, partial);
    this.previewDirty = false;
    this.unsaved = { revision: this.localRevision, settings: cloneSettings(this.settings) };
    pendingHandoff = {
      owner: this.owner,
      revision: this.localRevision,
      settings: cloneSettings(this.settings),
      baselineRaw: this.lastStoredRaw,
      conflicted: this.remoteConflict,
    };
    if (!this.remoteConflict) this.scheduleSave();
    this.notifyPersistence();
  }

  preview(partial: Partial<OverlaySettings>): void {
    if (this.retired || activeOwner !== this.owner) return;
    this.localRevision++;
    this.settings = applySettingsPatch(this.settings, partial);
    this.previewDirty = true;
  }

  reset(): void {
    if (this.retired || activeOwner !== this.owner) return;
    this.localRevision++;
    this.settings = cloneSettings(DEFAULT_SETTINGS);
    this.previewDirty = false;
    this.unsaved = { revision: this.localRevision, settings: cloneSettings(this.settings) };
    pendingHandoff = {
      owner: this.owner,
      revision: this.localRevision,
      settings: cloneSettings(this.settings),
      baselineRaw: this.lastStoredRaw,
      conflicted: this.remoteConflict,
    };
    if (!this.remoteConflict) this.scheduleSave();
    this.notifyPersistence();
    for (const cb of this.onChangeCallbacks) cb();
  }

  /** Only a direct user choice may replace a known remote decision. */
  chooseLocalAndPersist(): Promise<PersistenceState> {
    if (!this.unsaved || this.retired || activeOwner !== this.owner) {
      return Promise.resolve(this.persistenceState());
    }
    this.remoteConflict = false;
    if (pendingHandoff?.owner === this.owner) pendingHandoff.conflicted = false;
    this.notifyPersistence();
    return this.flushSave(true, true);
  }
}
