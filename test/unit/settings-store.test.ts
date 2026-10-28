// SPDX-License-Identifier: MIT

import { getCrossTabSyncAdapter } from '@platform/cross-tab-sync-adapters';
import { getStorageAdapter } from '@platform/storage-adapters';
import { Settings } from '@settings/store';
import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@platform/cross-tab-sync-adapters', () => ({
  getCrossTabSyncAdapter: vi.fn(() => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })),
}));

vi.mock('@platform/storage-adapters', () => ({
  getStorageAdapter: vi.fn(),
}));

describe('Settings persistence', () => {
  it('treats an unreadable first load differently from a verified missing record', async () => {
    let available = false;
    let stored: string | null = JSON.stringify({ fontSize: 48 });
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => {
        if (!available) throw new Error('read denied');
        return stored;
      }),
      setItem,
    });
    const settings = new Settings();
    await settings.initialize();
    expect(settings.persistenceState()).toBe('unsaved');
    expect(await settings.retrySave()).toBe('unsaved');
    expect(setItem).not.toHaveBeenCalled();
    available = true;
    expect(await settings.retrySave()).toBe('saved');
    expect(settings.get().fontSize).toBe(48);
    expect(setItem).not.toHaveBeenCalled();
    await settings.destroy();

    stored = null;
    const firstRun = new Settings();
    await firstRun.initialize();
    expect(firstRun.persistenceState()).toBe('saved');
    firstRun.set({ fontSize: 36 });
    expect(await firstRun.persistNow()).toBe('saved');
    expect(JSON.parse(stored ?? 'null').fontSize).toBe(36);
    await firstRun.destroy();
  });

  it('does not treat malformed saved JSON as a missing key', async () => {
    let stored = '{"fontSize":';
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => stored),
      setItem,
    });
    const settings = new Settings();
    await settings.initialize();
    expect(settings.persistenceState()).toBe('unsaved');
    settings.set({ opacity: 0.5 });
    expect(await settings.persistNow()).toBe('unsaved');
    expect(setItem).not.toHaveBeenCalled();
    stored = JSON.stringify({ fontSize: 48, speedPxPerSec: 420 });
    expect(await settings.retrySave()).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({ fontSize: 48, speedPxPerSec: 420, opacity: 0.5 });
    await settings.destroy();
  });

  it('recovers the original preferences after a preview is reverted with no net edit', async () => {
    let readable = false;
    const stored = JSON.stringify({ fontSize: 48, opacity: 0.75 });
    const setItem = vi.fn(async () => undefined);
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => {
        if (!readable) throw new Error('read denied');
        return stored;
      }),
      setItem,
    });
    const settings = new Settings();
    await settings.initialize();
    const startingOpacity = settings.get().opacity;
    settings.preview({ opacity: 0.5 });
    settings.preview({ opacity: startingOpacity });
    settings.endPreview();
    readable = true;
    expect(await settings.retrySave()).toBe('saved');
    expect(settings.get()).toMatchObject({ fontSize: 48, opacity: 0.75 });
    expect(setItem).not.toHaveBeenCalled();
    await settings.destroy();
  });

  it('ignores an older no-edit retry when a newer remote read has completed', async () => {
    let releaseRetry: (() => void) | undefined;
    let onRemote: ((value: string) => void) | undefined;
    let readCount = 0;
    const newer = JSON.stringify({ fontSize: 49, speedPxPerSec: 420 });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(() => {
        readCount++;
        if (readCount === 1) return Promise.reject(new Error('initial read denied'));
        if (readCount === 2) {
          return new Promise<string>((resolve) => {
            releaseRetry = () => resolve(JSON.stringify({ fontSize: 40 }));
          });
        }
        return Promise.resolve(newer);
      }),
      setItem: vi.fn(async () => undefined),
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = (value) => callback('yt-live-chat-overlay-settings', value);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    const olderRetry = settings.retrySave();
    await vi.waitFor(() => expect(releaseRetry).toBeTypeOf('function'));
    onRemote?.(newer);
    await vi.waitFor(() => expect(settings.get().fontSize).toBe(49));
    expect(settings.persistenceState()).toBe('saved');
    releaseRetry?.();
    expect(await olderRetry).toBe('saved');
    expect(settings.get()).toMatchObject({ fontSize: 49, speedPxPerSec: 420 });
    await settings.destroy();
  });

  it('finishes an accepted recovery save while a later form draft awaits preview', async () => {
    const existing = JSON.stringify({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
    let stored = existing;
    let reads = 0;
    let releaseRecovery: (() => void) | undefined;
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(() => {
        reads++;
        if (reads === 1) return Promise.reject(new Error('initial read denied'));
        if (reads === 2) {
          return new Promise<string>((resolve) => {
            releaseRecovery = () => resolve(existing);
          });
        }
        return Promise.resolve(stored);
      }),
      setItem: vi.fn(async (_key, value) => {
        stored = value;
      }),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ opacity: 0.5 });
    const priorSave = settings.persistNow();
    await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf('function'));
    settings.setDraftPending(true);
    releaseRecovery?.();
    expect(await priorSave).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({
      fontSize: 48,
      speedPxPerSec: 420,
      opacity: 0.5,
    });
    settings.preview({ fontSize: 36 });
    expect(JSON.parse(stored).fontSize).toBe(48);
    settings.set({ fontSize: 36 });
    expect(await settings.persistNow()).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({
      fontSize: 36,
      speedPxPerSec: 420,
      opacity: 0.5,
    });
    await settings.destroy();
  });

  it('holds a remote notification during a queued form draft for explicit conflict choice', async () => {
    let stored = JSON.stringify({ fontSize: 32, opacity: 1 });
    let onRemote: (() => void) | undefined;
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({ getItem: vi.fn(async () => stored), setItem });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = () => callback('yt-live-chat-overlay-settings', stored);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.setDraftPending(true);
    stored = JSON.stringify({ fontSize: 52, opacity: 0.75 });
    onRemote?.();
    expect(settings.persistenceState()).toBe('conflict');
    expect(settings.get().fontSize).toBe(32);
    expect(await settings.chooseLocalAndPersist()).toBe('conflict');
    expect(setItem).not.toHaveBeenCalled();
    settings.set({ fontSize: 36 });
    expect(await settings.persistNow()).toBe('conflict');
    expect(await settings.chooseLocalAndPersist()).toBe('saved');
    expect(JSON.parse(stored).fontSize).toBe(36);
    await settings.destroy();
  });

  it.each([
    { outcome: 'resolved', phase: 'queued' },
    { outcome: 'rejected', phase: 'queued' },
    { outcome: 'resolved', phase: 'previewed' },
    { outcome: 'rejected', phase: 'previewed' },
  ] as const)(
    'does not discard a $outcome remote read completed during $phase form input',
    async ({ outcome, phase }) => {
      let stored = JSON.stringify({ fontSize: 32, speedPxPerSec: 250, opacity: 1 });
      let releaseRead: (() => void) | undefined;
      let onRemote: (() => void) | undefined;
      const setItem = vi.fn(async (_key: string, value: string) => {
        stored = value;
      });
      vi.mocked(getStorageAdapter).mockReturnValue({
        getItem: vi
          .fn()
          .mockImplementationOnce(async () => stored)
          .mockImplementationOnce(
            () =>
              new Promise<string>((resolve, reject) => {
                releaseRead = () => {
                  if (outcome === 'rejected') reject(new Error('remote read denied'));
                  else resolve(stored);
                };
              })
          )
          .mockImplementation(async () => stored),
        setItem,
      });
      vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
        addListener: vi.fn((callback) => {
          onRemote = () => callback('yt-live-chat-overlay-settings', stored);
        }),
        removeListener: vi.fn(),
      });
      const settings = new Settings();
      await settings.initialize();
      stored = JSON.stringify({ fontSize: 52, speedPxPerSec: 420, opacity: 0.75 });
      onRemote?.();
      await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
      settings.setDraftPending(true);
      if (phase === 'previewed') settings.preview({ fontSize: 36 });
      releaseRead?.();
      await vi.waitFor(() => expect(settings.persistenceState()).toBe('conflict'));
      expect(settings.get()).toMatchObject({
        fontSize: phase === 'previewed' ? 36 : 32,
        speedPxPerSec: 250,
        opacity: 1,
      });
      expect(await settings.chooseLocalAndPersist()).toBe('conflict');
      if (phase === 'queued') settings.preview({ fontSize: 36 });
      settings.set({ fontSize: 36 });
      expect(await settings.persistNow()).toBe('conflict');
      expect(setItem).not.toHaveBeenCalled();
      expect(await settings.chooseLocalAndPersist()).toBe('saved');
      expect(JSON.parse(stored).fontSize).toBe(36);
      await settings.destroy();
    }
  );

  it('rejects a remote read begun before a draft that was accepted on close', async () => {
    let stored = JSON.stringify({ fontSize: 32 });
    let releaseRead: (() => void) | undefined;
    let onRemote: (() => void) | undefined;
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi
        .fn()
        .mockImplementationOnce(async () => stored)
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              releaseRead = () => resolve(JSON.stringify({ fontSize: 52 }));
            })
        )
        .mockImplementation(async () => stored),
      setItem: vi.fn(async (_key, value) => {
        stored = value;
      }),
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = () =>
          callback('yt-live-chat-overlay-settings', JSON.stringify({ fontSize: 52 }));
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    onRemote?.();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    settings.setDraftPending(true);
    settings.set({ fontSize: 36 });
    expect(await settings.persistNow()).toBe('saved');
    releaseRead?.();
    await Promise.resolve();
    expect(settings.get().fontSize).toBe(36);
    await settings.destroy();
  });

  it('retains explicit edits across a replacement owner and a denied recovery write', async () => {
    let stored = JSON.stringify({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
    let denyRead = true;
    let denyWrite = true;
    const setItem = vi.fn(async (_key: string, value: string) => {
      if (denyWrite) throw new Error('write denied');
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => {
        if (denyRead) throw new Error('read denied');
        return stored;
      }),
      setItem,
    });
    const old = new Settings();
    await old.initialize();
    old.set({ opacity: 0.5 });
    expect(await old.persistNow()).toBe('unsaved');
    expect(setItem).not.toHaveBeenCalled();

    const replacement = new Settings();
    await replacement.initialize();
    expect(replacement.get().opacity).toBe(0.5);
    expect(replacement.persistenceState()).toBe('unsaved');
    await old.destroy();
    denyRead = false;
    expect(await replacement.retrySave()).toBe('unsaved');
    expect(JSON.parse(stored).opacity).toBe(0.75);
    denyWrite = false;
    expect(await replacement.retrySave()).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({
      fontSize: 48,
      speedPxPerSec: 420,
      opacity: 0.5,
    });
    await replacement.destroy();
  });

  it('keeps the newest edit when recovery reads a stale baseline asynchronously', async () => {
    const existing = JSON.stringify({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
    let stored = existing;
    let reads = 0;
    let completeRecovery: (() => void) | undefined;
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(() => {
        reads++;
        if (reads === 1) return Promise.reject(new Error('initial read denied'));
        return new Promise<string>((resolve) => {
          completeRecovery = () => resolve(existing);
        });
      }),
      setItem,
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ opacity: 0.5 });
    const first = settings.persistNow();
    await vi.waitFor(() => expect(completeRecovery).toBeTypeOf('function'));
    settings.set({ opacity: 0.65 });
    completeRecovery?.();
    await first;
    expect(JSON.parse(stored)).toMatchObject({
      fontSize: 48,
      speedPxPerSec: 420,
      opacity: 0.65,
    });
    await settings.destroy();
  });

  it('keeps a newer form preview visible until its explicit close while an older recovery waits', async () => {
    const existing = JSON.stringify({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
    let stored = existing;
    let reads = 0;
    let completeRecovery: (() => void) | undefined;
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(() => {
        reads++;
        if (reads === 1) return Promise.reject(new Error('initial read denied'));
        if (reads === 2) {
          return new Promise<string>((resolve) => {
            completeRecovery = () => resolve(existing);
          });
        }
        return Promise.resolve(stored);
      }),
      setItem,
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ opacity: 0.5 });
    const recovery = settings.persistNow();
    await vi.waitFor(() => expect(completeRecovery).toBeTypeOf('function'));

    const formSync = vi.fn();
    settings.subscribe(formSync);
    settings.preview({ fontSize: 36 });
    completeRecovery?.();
    expect(await recovery).toBe('unsaved');
    expect(settings.get()).toMatchObject({ fontSize: 36, opacity: 0.5 });
    expect(formSync).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(stored).toBe(existing);

    settings.set({ fontSize: 36 });
    expect(await settings.persistNow()).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({ fontSize: 36, speedPxPerSec: 420, opacity: 0.5 });
    await settings.destroy();
  });

  it('retries an older committed edit when a reverted preview closes as recovery settles', async () => {
    const existing = JSON.stringify({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
    let stored = existing;
    let reads = 0;
    let completeRecovery: (() => void) | undefined;
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(() => {
        reads++;
        if (reads === 1) return Promise.reject(new Error('initial read denied'));
        if (reads === 2) {
          return new Promise<string>((resolve) => {
            completeRecovery = () => resolve(existing);
          });
        }
        return Promise.resolve(stored);
      }),
      setItem,
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ opacity: 0.5 });
    const recovery = settings.persistNow();
    await vi.waitFor(() => expect(completeRecovery).toBeTypeOf('function'));
    settings.preview({ fontSize: 36 });
    settings.preview({ fontSize: 32 });

    completeRecovery?.();
    const close = Promise.resolve().then(() => {
      settings.endPreview();
      return settings.persistNow();
    });
    expect(await recovery).toBe('unsaved');
    expect(await close).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({ fontSize: 48, speedPxPerSec: 420, opacity: 0.5 });
    expect(setItem).toHaveBeenCalledTimes(1);
    await settings.destroy();
  });

  it('does not write over a remote change announced during initial recovery', async () => {
    let completeRecovery: (() => void) | undefined;
    let onRemote: ((value: string) => void) | undefined;
    let recoveryReads = 0;
    const setItem = vi.fn(async () => undefined);
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi
        .fn()
        .mockRejectedValueOnce(new Error('initial read denied'))
        .mockImplementation(() => {
          recoveryReads++;
          if (recoveryReads > 1) return Promise.resolve(JSON.stringify({ fontSize: 53 }));
          return new Promise<string>((resolve) => {
            completeRecovery = () => resolve(JSON.stringify({ fontSize: 48 }));
          });
        }),
      setItem,
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = (value) => callback('yt-live-chat-overlay-settings', value);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ opacity: 0.5 });
    const recovery = settings.persistNow();
    await vi.waitFor(() => expect(completeRecovery).toBeTypeOf('function'));
    onRemote?.(JSON.stringify({ fontSize: 53 }));
    completeRecovery?.();
    expect(await recovery).toBe('conflict');
    expect(setItem).not.toHaveBeenCalled();
    expect(settings.get().opacity).toBe(0.5);
    expect(await settings.chooseLocalAndPersist()).toBe('saved');
    await settings.destroy();
  });

  it('keeps a deliberate reset pending until an unreadable prior record is recovered', async () => {
    let readable = false;
    let stored = JSON.stringify({ fontSize: 48, speedPxPerSec: 420 });
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => {
        if (!readable) throw new Error('read denied');
        return stored;
      }),
      setItem,
    });
    const settings = new Settings();
    await settings.initialize();
    settings.reset();
    expect(await settings.persistNow()).toBe('unsaved');
    expect(setItem).not.toHaveBeenCalled();
    readable = true;
    expect(await settings.retrySave()).toBe('saved');
    expect(JSON.parse(stored).fontSize).toBe(settings.get().fontSize);
    expect(JSON.parse(stored).speedPxPerSec).toBe(settings.get().speedPxPerSec);
    await settings.destroy();
  });

  it('keeps legacy font preferences through an ordinary save and reload', async () => {
    let stored = JSON.stringify({
      _version: 1,
      fontBaseViewportHeight: 720,
      fontMinSize: 12,
      fontMaxSize: 42,
      fontSize: 30,
    });
    const getItem = vi.fn(async () => stored);
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({ getItem, setItem });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const settings = new Settings();
    await settings.initialize();
    expect(settings.get()).toMatchObject({
      fontBaseViewportHeight: 720,
      fontMinSize: 12,
      fontMaxSize: 42,
      fontSize: 30,
    });

    settings.set({ fontSize: 38, speedPxPerSec: 320 });
    await (settings as unknown as { flushSave: () => Promise<void> }).flushSave();
    expect(JSON.parse(stored)).toMatchObject({
      fontBaseViewportHeight: 720,
      fontMinSize: 12,
      fontMaxSize: 42,
      fontSize: 38,
      speedPxPerSec: 320,
    });

    const reloaded = new Settings();
    await reloaded.initialize();
    expect(reloaded.get()).toMatchObject({
      fontBaseViewportHeight: 720,
      fontMinSize: 12,
      fontMaxSize: 42,
      fontSize: 38,
      speedPxPerSec: 320,
    });
    await settings.destroy();
    await reloaded.destroy();
  });

  it('serializes async writes so the newest snapshot wins', async () => {
    const pendingWrites: Array<{
      value: string;
      resolve: () => void;
    }> = [];
    const setItem = vi.fn(
      (_key: string, value: string) =>
        new Promise<void>((resolve) => {
          pendingWrites.push({ value, resolve });
        })
    );
    const getItem = vi.fn().mockResolvedValue(null);

    vi.mocked(getStorageAdapter).mockReturnValue({ getItem, setItem });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const settings = new Settings();
    const internals = settings as unknown as {
      flushSave: () => Promise<void>;
    };

    await settings.initialize();
    settings.set({ fontSize: 40 });
    const firstFlush = internals.flushSave();
    await Promise.resolve();
    expect(setItem).toHaveBeenCalledTimes(1);

    settings.set({ fontSize: 50 });
    const secondFlush = internals.flushSave();
    await Promise.resolve();

    // The second write waits for the first adapter operation to finish.
    expect(setItem).toHaveBeenCalledTimes(1);
    pendingWrites[0]!.resolve();
    await firstFlush;
    await Promise.resolve();
    pendingWrites[1]!.resolve();
    await secondFlush;

    expect(setItem).toHaveBeenCalledTimes(2);
    const latest = JSON.parse(pendingWrites[1]!.value) as { fontSize: number };
    expect(latest.fontSize).toBe(50);
  });

  it('retains session settings after denial and saves the intended value on one explicit retry', async () => {
    let stored: string | null = null;
    let denied = true;
    const setItem = vi.fn(async (_key: string, value: string) => {
      if (denied) throw new Error('storage denied');
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => stored),
      setItem,
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ fontSize: 47 });

    expect(await settings.persistNow()).toBe('unsaved');
    expect(settings.get().fontSize).toBe(47);
    expect(stored).toBeNull();
    expect(setItem).toHaveBeenCalledTimes(1);

    expect(await settings.retrySave()).toBe('unsaved');
    expect(setItem).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(setItem).toHaveBeenCalledTimes(2);

    denied = false;
    expect(await settings.retrySave()).toBe('saved');
    expect(setItem).toHaveBeenCalledTimes(3);
    const replacement = new Settings();
    await replacement.initialize();
    expect(replacement.get().fontSize).toBe(47);
    await settings.destroy();
    await replacement.destroy();
  });

  it('keeps a newer edit dirty when an older in-flight write finishes', async () => {
    let completeFirst: (() => void) | undefined;
    let stored: string | null = null;
    let failSecond = true;
    const setItem = vi.fn((_key: string, value: string) => {
      if (!completeFirst) {
        return new Promise<void>((resolve) => {
          completeFirst = () => {
            stored = value;
            resolve();
          };
        });
      }
      if (failSecond) {
        failSecond = false;
        return Promise.reject(new Error('second denied'));
      }
      stored = value;
      return Promise.resolve();
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => stored),
      setItem,
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ fontSize: 40 });
    const first = settings.persistNow();
    await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
    settings.set({ fontSize: 50 });
    const second = settings.persistNow();
    expect(setItem).toHaveBeenCalledTimes(1);
    completeFirst?.();
    await first;
    expect(await second).toBe('unsaved');
    expect(settings.get().fontSize).toBe(50);
    expect(JSON.parse(stored!).fontSize).toBe(40);
    expect(await settings.retrySave()).toBe('saved');
    expect(JSON.parse(stored!).fontSize).toBe(50);
    await settings.destroy();
  });

  it('holds a failed local edit when another tab writes, until the user explicitly chooses it', async () => {
    let stored: string | null = null;
    let denied = true;
    let onRemote: (() => void) | undefined;
    const setItem = vi.fn(async (_key: string, value: string) => {
      if (denied) throw new Error('storage denied');
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({ getItem: vi.fn(async () => stored), setItem });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = () => callback('yt-live-chat-overlay-settings', stored);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ fontSize: 46 });
    expect(await settings.persistNow()).toBe('unsaved');
    stored = JSON.stringify({ fontSize: 53 });
    onRemote?.();
    denied = false;
    expect(settings.persistenceState()).toBe('conflict');
    expect(settings.get().fontSize).toBe(46);
    expect(await settings.retrySave()).toBe('conflict');
    expect(setItem).toHaveBeenCalledTimes(1);

    settings.set({ fontSize: 46 }); // a normal form close is not conflict resolution
    expect(await settings.persistNow()).toBe('conflict');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(await settings.chooseLocalAndPersist()).toBe('saved');
    expect(JSON.parse(stored).fontSize).toBe(46);
    await settings.destroy();
  });

  it('does not replace an open settings preview with a remote change', async () => {
    let stored = JSON.stringify({ fontSize: 32 });
    let onRemote: (() => void) | undefined;
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => stored),
      setItem: vi.fn(async (_key, value) => {
        stored = value;
      }),
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = () => callback('yt-live-chat-overlay-settings', stored);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.preview({ fontSize: 45 });
    stored = JSON.stringify({ fontSize: 52 });
    onRemote?.();
    expect(settings.get().fontSize).toBe(45);
    expect(settings.persistenceState()).toBe('conflict');
    expect(await settings.retrySave()).toBe('conflict');
    expect(JSON.parse(stored).fontSize).toBe(52);
    settings.set({ fontSize: 45 });
    expect(await settings.persistNow()).toBe('conflict');
    expect(await settings.chooseLocalAndPersist()).toBe('saved');
    await settings.destroy();
  });

  it('resolves a preview-time remote conflict with the accepted form value after close', async () => {
    let stored = JSON.stringify({ fontSize: 32, opacity: 1 });
    let onRemote: (() => void) | undefined;
    const setItem = vi.fn(async (_key: string, value: string) => {
      stored = value;
    });
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => stored),
      setItem,
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = () => callback('yt-live-chat-overlay-settings', stored);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.preview({ fontSize: 45 });
    stored = JSON.stringify({ fontSize: 52, opacity: 1 });
    onRemote?.();
    expect(settings.persistenceState()).toBe('conflict');
    expect(await settings.chooseLocalAndPersist()).toBe('conflict');
    expect(setItem).not.toHaveBeenCalled();

    settings.preview({ fontSize: 32 });
    settings.endPreview();
    expect(await settings.persistNow()).toBe('conflict');
    expect(await settings.chooseLocalAndPersist()).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({ fontSize: 32, opacity: 1 });
    expect(setItem).toHaveBeenCalledTimes(1);
    await settings.destroy();
  });

  for (const localWriteFinishesLast of [false, true]) {
    it(`keeps an in-flight remote conflict visible when the local write finishes ${localWriteFinishesLast ? 'last' : 'first'}`, async () => {
      let stored = JSON.stringify({ fontSize: 32 });
      let releaseFirst: (() => void) | undefined;
      let onChange: ((value: string) => void) | undefined;
      const setItem = vi.fn((_key: string, value: string) => {
        if (!releaseFirst) {
          if (!localWriteFinishesLast) stored = value;
          return new Promise<void>((resolve) => {
            releaseFirst = () => {
              if (localWriteFinishesLast) stored = value;
              resolve();
            };
          });
        }
        stored = value;
        return Promise.resolve();
      });
      vi.mocked(getStorageAdapter).mockReturnValue({ getItem: vi.fn(async () => stored), setItem });
      vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
        addListener: vi.fn((callback) => {
          onChange = (value) => callback('yt-live-chat-overlay-settings', value);
        }),
        removeListener: vi.fn(),
      });
      const old = new Settings();
      await old.initialize();
      old.set({ fontSize: 44 });
      const firstSave = old.persistNow();
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
      const localRaw = JSON.stringify({ ...old.get(), _version: 2 });
      onChange?.(localRaw); // own echo is not a remote conflict
      expect(old.persistenceState()).toBe('pending');

      stored = JSON.stringify({ fontSize: 53 });
      onChange?.(stored);
      expect(old.persistenceState()).toBe('conflict');
      releaseFirst?.();
      expect(await firstSave).toBe('conflict');
      expect(old.get().fontSize).toBe(44);
      expect(await old.retrySave()).toBe('conflict');
      old.set({ fontSize: 44 }); // ordinary modal close must stay blocked
      expect(await old.persistNow()).toBe('conflict');
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(JSON.parse(stored).fontSize).toBe(localWriteFinishesLast ? 44 : 53);

      const replacement = new Settings();
      await replacement.initialize();
      expect(replacement.get().fontSize).toBe(44);
      expect(replacement.persistenceState()).toBe('conflict');
      await old.destroy();
      expect(await replacement.chooseLocalAndPersist()).toBe('saved');
      expect(JSON.parse(stored).fontSize).toBe(44);
      await replacement.destroy();
    });
  }

  it('treats a remote restore to the previous value during a write as a conflict', async () => {
    const baseline = JSON.stringify({ fontSize: 32 });
    let stored = baseline;
    let releaseWrite: (() => void) | undefined;
    let onRemote: ((value: string) => void) | undefined;
    const setItem = vi.fn((_key: string, value: string) => {
      stored = value;
      if (releaseWrite) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    });
    vi.mocked(getStorageAdapter).mockReturnValue({ getItem: vi.fn(async () => stored), setItem });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = (value) => callback('yt-live-chat-overlay-settings', value);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ fontSize: 44 });
    const save = settings.persistNow();
    await vi.waitFor(() => expect(JSON.parse(stored).fontSize).toBe(44));
    stored = baseline;
    onRemote?.(baseline);
    expect(settings.persistenceState()).toBe('conflict');
    releaseWrite?.();
    expect(await save).toBe('conflict');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored).fontSize).toBe(32);
    expect(await settings.chooseLocalAndPersist()).toBe('saved');
    await settings.destroy();
  });

  it('requires the explicit conflict save to finish even when chosen before an older write settles', async () => {
    let stored = JSON.stringify({ fontSize: 32 });
    let releaseFirst: (() => void) | undefined;
    let onRemote: ((value: string) => void) | undefined;
    const setItem = vi.fn((_key: string, value: string) => {
      if (!releaseFirst) {
        return new Promise<void>((resolve) => {
          releaseFirst = () => {
            stored = value;
            resolve();
          };
        });
      }
      stored = value;
      return Promise.resolve();
    });
    vi.mocked(getStorageAdapter).mockReturnValue({ getItem: vi.fn(async () => stored), setItem });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = (value) => callback('yt-live-chat-overlay-settings', value);
      }),
      removeListener: vi.fn(),
    });
    const settings = new Settings();
    await settings.initialize();
    settings.set({ fontSize: 44 });
    const older = settings.persistNow();
    await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
    stored = JSON.stringify({ fontSize: 53 });
    onRemote?.(stored);
    expect(settings.persistenceState()).toBe('conflict');
    const chosen = settings.chooseLocalAndPersist();
    expect(setItem).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    expect(await older).toBe('pending');
    expect(await chosen).toBe('saved');
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stored).fontSize).toBe(44);
    await settings.destroy();
  });

  it('hands a failed choice to a new in-document owner without removing its listener', async () => {
    let stored: string | null = null;
    let denied = true;
    const listener = { addListener: vi.fn(), removeListener: vi.fn() };
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue(listener);
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => stored),
      setItem: vi.fn(async (_key, value) => {
        if (denied) throw new Error('storage denied');
        stored = value;
      }),
    });
    const old = new Settings();
    await old.initialize();
    old.set({ fontSize: 45 });
    expect(await old.persistNow()).toBe('unsaved');

    const replacement = new Settings();
    await replacement.initialize();
    expect(replacement.get().fontSize).toBe(45);
    expect(replacement.persistenceState()).toBe('unsaved');
    await old.destroy();
    expect(listener.removeListener).not.toHaveBeenCalled();
    denied = false;
    expect(await replacement.retrySave()).toBe('saved');
    expect(JSON.parse(stored!).fontSize).toBe(45);
    await replacement.destroy();
    expect(listener.removeListener).toHaveBeenCalledTimes(1);
  });

  it('forgets a confirmed handoff edit before a later denied read and unrelated local edit', async () => {
    let stored: string | null = null;
    let loseFirstWriteAcknowledgement = true;
    let failNextRead = false;
    let onRemote: ((value: string) => void) | undefined;
    vi.mocked(getStorageAdapter).mockReturnValue({
      getItem: vi.fn(async () => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('later read denied');
        }
        return stored;
      }),
      setItem: vi.fn(async (_key, value) => {
        stored = value;
        if (loseFirstWriteAcknowledgement) {
          loseFirstWriteAcknowledgement = false;
          throw new Error('acknowledgement lost after durable write');
        }
      }),
    });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn((callback) => {
        onRemote = (value) => callback('yt-live-chat-overlay-settings', value);
      }),
      removeListener: vi.fn(),
    });
    const first = new Settings();
    await first.initialize();
    first.set({ fontSize: 44 });
    expect(await first.persistNow()).toBe('unsaved');
    const replacement = new Settings();
    await replacement.initialize();
    expect(replacement.persistenceState()).toBe('saved');
    await first.destroy();

    failNextRead = true;
    onRemote?.(JSON.stringify({ fontSize: 49 }));
    await vi.waitFor(() => expect(replacement.persistenceState()).toBe('unsaved'));
    stored = JSON.stringify({ fontSize: 49, speedPxPerSec: 420 });
    replacement.set({ opacity: 0.5 });
    expect(await replacement.persistNow()).toBe('saved');
    expect(JSON.parse(stored)).toMatchObject({
      fontSize: 49,
      speedPxPerSec: 420,
      opacity: 0.5,
    });
    await replacement.destroy();
  });

  it('waits for the old owner write before a replacement reads or saves', async () => {
    let stored: string | null = null;
    let releaseOld: (() => void) | undefined;
    const setItem = vi.fn((_key: string, value: string) => {
      if (!releaseOld) {
        return new Promise<void>((resolve) => {
          releaseOld = () => {
            stored = value;
            resolve();
          };
        });
      }
      stored = value;
      return Promise.resolve();
    });
    vi.mocked(getStorageAdapter).mockReturnValue({ getItem: vi.fn(async () => stored), setItem });
    vi.mocked(getCrossTabSyncAdapter).mockReturnValue({
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });
    const old = new Settings();
    await old.initialize();
    old.set({ fontSize: 41 });
    const oldSave = old.persistNow();
    await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
    const replacement = new Settings();
    let initialized = false;
    const newInit = replacement.initialize().then(() => {
      initialized = true;
    });
    await Promise.resolve();
    expect(initialized).toBe(false);
    releaseOld?.();
    await oldSave;
    await newInit;
    expect(replacement.get().fontSize).toBe(41);
    replacement.set({ fontSize: 49 });
    expect(await replacement.persistNow()).toBe('saved');
    expect(JSON.parse(stored!).fontSize).toBe(49);
    await old.destroy();
    await replacement.destroy();
  });
});
