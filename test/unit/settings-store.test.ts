// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

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
});
