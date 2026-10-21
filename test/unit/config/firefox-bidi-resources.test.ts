// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { closeFirefoxResources } from '../../e2e/fixtures/firefox-bidi';

const profiles: string[] = [];

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'yt-firefox-resources-test-'));
  profiles.push(path);
  return path;
}

function ownedChild(signals: string[]): Parameters<typeof closeFirefoxResources>[1] {
  return {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(String(signal));
      return true;
    },
  };
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('Firefox BiDi resource teardown', () => {
  it('reports both extension and session failures while closing the owned process and profile', async () => {
    const path = profile();
    const signals: string[] = [];
    const uninstallFailure = new Error('extension uninstall failed');
    const closeFailure = new Error('session close failed');
    const browser = {
      uninstallExtension: async () => {
        throw uninstallFailure;
      },
      close: async () => {
        throw closeFailure;
      },
    };

    await expect(
      closeFirefoxResources(browser, ownedChild(signals), Promise.resolve(), path, 'extension-id')
    ).rejects.toMatchObject({ errors: [uninstallFailure, closeFailure] });
    expect(signals).toEqual(['SIGTERM']);
    expect(existsSync(path)).toBe(false);
  });

  it('bounds a stalled public API close and still removes the profile after observed child closure', async () => {
    const path = profile();
    const signals: string[] = [];
    const browser = {
      uninstallExtension: async () => {},
      close: () => new Promise<void>(() => {}),
    };

    await expect(
      closeFirefoxResources(browser, ownedChild(signals), Promise.resolve(), path, null, {
        closeTimeoutMs: 5,
      })
    ).rejects.toThrow('Firefox BiDi session close timed out');
    expect(signals).toEqual(['SIGTERM']);
    expect(existsSync(path)).toBe(false);
  });

  it('retains the original close failure when process closure is unconfirmed', async () => {
    const path = profile();
    const signals: string[] = [];
    const closeFailure = new Error('session close failed');
    const browser = {
      uninstallExtension: async () => {},
      close: async () => {
        throw closeFailure;
      },
    };

    await expect(
      closeFirefoxResources(browser, ownedChild(signals), new Promise<void>(() => {}), path, null, {
        profile: { closeTimeoutMs: 5 },
      })
    ).rejects.toMatchObject({
      errors: [
        closeFailure,
        expect.objectContaining({ message: 'Firefox process did not close; profile retained' }),
      ],
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(path)).toBe(true);
  });
});
