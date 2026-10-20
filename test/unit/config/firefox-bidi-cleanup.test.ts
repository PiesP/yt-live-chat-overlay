// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { cleanupFirefoxProfile } from '../../e2e/fixtures/firefox-bidi';

const profiles: string[] = [];

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'yt-firefox-cleanup-test-'));
  writeFileSync(join(path, 'parent.lock'), 'owned');
  profiles.push(path);
  return path;
}

function child(signals: string[], exited = false): Parameters<typeof cleanupFirefoxProfile>[0] {
  return {
    exitCode: exited ? 0 : null,
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

describe('owned Firefox BiDi profile cleanup', () => {
  it('retains the profile after process exit until the close signal confirms stream closure', async () => {
    const path = profile();
    const signals: string[] = [];
    let markClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const pending = cleanupFirefoxProfile(child(signals, true), closed, path, {
      closeTimeoutMs: 100,
    });
    await Promise.resolve();
    expect(existsSync(path)).toBe(true);
    expect(signals).toEqual([]);
    markClosed?.();
    await pending;
    expect(existsSync(path)).toBe(false);
  });

  it('stops after the owned child closes following TERM', async () => {
    const path = profile();
    const signals: string[] = [];
    let markClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const pending = cleanupFirefoxProfile(child(signals), closed, path, {
      closeTimeoutMs: 100,
    });
    expect(signals).toEqual(['SIGTERM']);
    markClosed?.();
    await pending;
    expect(signals).toEqual(['SIGTERM']);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps the profile and fails after bounded TERM and KILL when closure is unconfirmed', async () => {
    const path = profile();
    const signals: string[] = [];
    await expect(
      cleanupFirefoxProfile(child(signals), new Promise<void>(() => {}), path, {
        closeTimeoutMs: 5,
      })
    ).rejects.toThrow('Firefox process did not close; profile retained');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(path)).toBe(true);
  });

  it('retries transient EPERM on the owned profile, then removes it', async () => {
    const path = profile();
    let attempts = 0;
    await cleanupFirefoxProfile(child([], true), Promise.resolve(), path, {
      retryDelayMs: 0,
      removeProfile(ownedPath) {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('profile busy'), { code: 'EPERM' });
        rmSync(ownedPath, { force: true, recursive: true });
      },
    });
    expect(attempts).toBe(3);
    expect(existsSync(path)).toBe(false);
  });

  it('does not hide exhausted EPERM retries or retry other deletion errors', async () => {
    const path = profile();
    let attempts = 0;
    const fail = (code: string) => {
      attempts++;
      throw Object.assign(new Error('cannot remove profile'), { code });
    };
    await expect(
      cleanupFirefoxProfile(child([], true), Promise.resolve(), path, {
        maxRemoveRetries: 2,
        retryDelayMs: 0,
        removeProfile: () => fail('EPERM'),
      })
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(attempts).toBe(3);
    expect(existsSync(path)).toBe(true);
    attempts = 0;
    await expect(
      cleanupFirefoxProfile(child([], true), Promise.resolve(), path, {
        removeProfile: () => fail('EACCES'),
      })
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(attempts).toBe(1);
  });
});
