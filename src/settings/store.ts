// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import { getCrossTabSyncAdapter } from '@platform/cross-tab-sync-adapters';
import { getStorageAdapter } from '@platform/storage-adapters';
import {
  applySettingsPatch,
  cloneSettings,
  combineSettingsPatches,
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
  patch: Partial<OverlaySettings>;
  baselineAvailable: boolean;
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
  /** Edits made without a readable starting record must survive recovery. */
  private pendingPatch: Partial<OverlaySettings> = {};
  private baselineAvailable = false;
  private writeFailed = false;
  private remoteConflict = false;
  private conflictEpoch = 0;
  /** Invalidates older read results when a new storage notification arrives. */
  private storageEpoch = 0;
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
    this.storageEpoch++;
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
          patch: cloneSettings(this.settings),
          baselineAvailable: this.baselineAvailable,
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
    let raw: string | null = null;
    let readable = false;
    try {
      raw = await getStorageAdapter().getItem(STORAGE_KEY);
      // A malformed record is an unavailable baseline, not a missing record.
      this.readSettings(raw);
      readable = true;
    } catch (error: unknown) {
      log.warn('settings.store.load-failed', { error: String(error) });
    }
    if (this.retired || activeOwner !== this.owner) return;
    const handoff = pendingHandoff;
    if (handoff) {
      this.pendingPatch = handoff.patch;
      this.settings = cloneSettings(handoff.settings);
      if (readable && raw === serialized(handoff.settings) && !handoff.conflicted) {
        this.lastStoredRaw = raw;
        this.baselineAvailable = true;
        this.pendingPatch = {};
        pendingHandoff = null;
      } else {
        this.localRevision++;
        this.baselineAvailable = readable;
        if (readable && !handoff.baselineAvailable) {
          this.settings = applySettingsPatch(this.readSettings(raw), handoff.patch);
          this.lastStoredRaw = raw;
        } else {
          this.lastStoredRaw = handoff.baselineRaw;
        }
        this.unsaved = { revision: this.localRevision, settings: cloneSettings(this.settings) };
        this.remoteConflict =
          handoff.conflicted ||
          (readable && handoff.baselineAvailable && raw !== handoff.baselineRaw);
        this.writeFailed = !this.remoteConflict;
        pendingHandoff = {
          ...handoff,
          owner: this.owner,
          revision: this.localRevision,
          settings: cloneSettings(this.settings),
          baselineAvailable: this.baselineAvailable,
        };
      }
    } else if (readable) {
      this.baselineAvailable = true;
      this.lastStoredRaw = raw;
      this.settings = this.readSettings(raw);
    } else {
      this.writeFailed = true;
    }
    if (this.retired || activeOwner !== this.owner) return;
    this.crossTabSyncAdapter.addListener(this.onCrossTabChange);
    this.notifyPersistence();
  }

  private readSettings(raw: string | null): OverlaySettings {
    if (raw === null) return cloneSettings(DEFAULT_SETTINGS);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Stored settings are not an object');
    }
    return normalizeStoredSettings(parsed as Record<string, unknown>);
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
    if (this.writeFailed || !this.baselineAvailable) return 'unsaved';
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
    const storageEpochAtStart = this.storageEpoch;
    try {
      const raw = await getStorageAdapter().getItem(STORAGE_KEY);
      const recovered = this.readSettings(raw);
      if (this.retired || activeOwner !== this.owner || storageEpochAtStart !== this.storageEpoch)
        return;
      if (
        revisionAtStart !== this.localRevision ||
        this.unsaved ||
        this.previewDirty ||
        this.saving ||
        this.savePromise
      )
        return;
      this.settings = recovered;
      this.lastStoredRaw = raw;
      this.baselineAvailable = true;
      this.writeFailed = false;
      for (const cb of this.onChangeCallbacks) cb();
      this.notifyPersistence();
    } catch (error: unknown) {
      log.warn('settings.store.reload-failed', { error: String(error) });
      if (storageEpochAtStart !== this.storageEpoch) return;
      if (!this.unsaved && !this.previewDirty) {
        this.baselineAvailable = false;
        this.writeFailed = true;
        this.notifyPersistence();
      }
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
      if (!this.baselineAvailable) {
        try {
          const recoveredRaw = await getStorageAdapter().getItem(STORAGE_KEY);
          const recovered = this.readSettings(recoveredRaw);
          if (this.retired || activeOwner !== this.owner || this.remoteConflict || !this.unsaved) {
            return this.persistenceState();
          }
          this.baselineAvailable = true;
          this.lastStoredRaw = recoveredRaw;
          this.settings = applySettingsPatch(recovered, this.pendingPatch);
          this.unsaved = {
            revision: this.unsaved.revision,
            settings: cloneSettings(this.settings),
          };
          if (pendingHandoff?.owner === this.owner) {
            pendingHandoff.settings = cloneSettings(this.settings);
            pendingHandoff.baselineRaw = recoveredRaw;
            pendingHandoff.baselineAvailable = true;
          }
          for (const callback of this.onChangeCallbacks) callback();
        } catch (error: unknown) {
          this.writeFailed = true;
          log.warn('settings.store.recovery-failed', { error: String(error) });
          return this.settledState();
        }
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
          this.pendingPatch = {};
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
    if (!this.unsaved && !this.baselineAvailable && !this.previewDirty)
      return this.recoverWithoutEdits();
    return this.flushSave(true);
  }

  private async recoverWithoutEdits(): Promise<PersistenceState> {
    const revision = this.localRevision;
    const storageEpochAtStart = this.storageEpoch;
    try {
      const raw = await getStorageAdapter().getItem(STORAGE_KEY);
      const recovered = this.readSettings(raw);
      if (
        this.retired ||
        activeOwner !== this.owner ||
        revision !== this.localRevision ||
        storageEpochAtStart !== this.storageEpoch
      ) {
        return this.persistenceState();
      }
      this.settings = recovered;
      this.lastStoredRaw = raw;
      this.baselineAvailable = true;
      this.writeFailed = false;
      for (const callback of this.onChangeCallbacks) callback();
    } catch (error: unknown) {
      if (storageEpochAtStart !== this.storageEpoch) return this.persistenceState();
      this.writeFailed = true;
      log.warn('settings.store.recovery-failed', { error: String(error) });
    }
    this.notifyPersistence();
    return this.persistenceState();
  }

  get(): Readonly<OverlaySettings> {
    return cloneSettings(this.settings);
  }

  set(partial: Partial<OverlaySettings>): void {
    if (this.retired || activeOwner !== this.owner) return;
    if (Object.keys(partial).length === 0) return;
    this.localRevision++;
    this.settings = applySettingsPatch(this.settings, partial);
    this.pendingPatch = combineSettingsPatches(this.pendingPatch, partial);
    this.previewDirty = false;
    this.unsaved = { revision: this.localRevision, settings: cloneSettings(this.settings) };
    pendingHandoff = {
      owner: this.owner,
      revision: this.localRevision,
      settings: cloneSettings(this.settings),
      patch: this.pendingPatch,
      baselineAvailable: this.baselineAvailable,
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

  /** A dialog closed with no net edit must release its transient preview. */
  endPreview(): void {
    this.previewDirty = false;
  }

  reset(): void {
    if (this.retired || activeOwner !== this.owner) return;
    this.localRevision++;
    this.settings = cloneSettings(DEFAULT_SETTINGS);
    this.pendingPatch = cloneSettings(this.settings);
    this.previewDirty = false;
    this.unsaved = { revision: this.localRevision, settings: cloneSettings(this.settings) };
    pendingHandoff = {
      owner: this.owner,
      revision: this.localRevision,
      settings: cloneSettings(this.settings),
      patch: this.pendingPatch,
      baselineAvailable: this.baselineAvailable,
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
    this.pendingPatch = cloneSettings(this.settings);
    if (pendingHandoff?.owner === this.owner) {
      pendingHandoff.conflicted = false;
      pendingHandoff.patch = this.pendingPatch;
    }
    this.notifyPersistence();
    return this.flushSave(true, true);
  }
}
