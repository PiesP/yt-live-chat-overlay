// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as durationModule from '../../../validation/windows/live-duration.mjs';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as installProfileModule from '../../../validation/windows/install-profile.mjs';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as naturalChromeModule from '../../../validation/windows/natural-chrome.mjs';

const healthySample = {
  phase: 'active',
  visibility: 'visible',
  canvasAttached: true,
  installedBridgeReady: true,
  playerErrorUi: { visible: false, marker: null },
  video: {
    currentTime: 10,
    errorCode: null,
    muted: true,
    paused: false,
    readyState: 4,
  },
};

describe('public duration observation contract', () => {
  it('accepts only the reviewed twenty-minute option', () => {
    expect(installProfileModule.validateLiveObservation(null)).toBeNull();
    expect(installProfileModule.validateLiveObservation({
      mode: 'duration',
      duration_seconds: 1200,
    })).toEqual({ mode: 'duration', duration_seconds: 1200 });

    expect(installProfileModule.validateLiveObservation()).toBeNull();

    for (const invalid of [
      { mode: 'duration', duration_seconds: 60 },
      { mode: 'short', duration_seconds: 1200 },
      { mode: 'duration', duration_seconds: 1200, preflight_seconds: 300 },
    ]) {
      expect(() => installProfileModule.validateLiveObservation(invalid)).toThrow(
        /live observation/u
      );
    }
  });

  it('preserves the controller-admitted public YouTube URL policy', () => {
    expect(durationModule.validateDurationLiveUrl(
      'https://www.youtube.com/watch?v=public&list=playlist'
    )).toBe('https://www.youtube.com/watch?v=public&list=playlist');
    expect(durationModule.validateDurationLiveUrl(
      'https://www.youtube.com/live/public-id?feature=share'
    )).toBe('https://www.youtube.com/live/public-id?feature=share');
    for (const invalid of [
      'https://youtube.com/watch?v=public',
      'https://www.youtube.com/embed/public',
      'https://www.youtube.com/watch?v=public#comment',
    ]) {
      expect(() => durationModule.validateDurationLiveUrl(invalid)).toThrow();
    }
  });

  it('does not accept duration evidence without a native hidden transition', () => {
    const reasons = durationModule.durationEvidenceReasons({
      visibilityProof: ['visible', 'visible'],
      samples: [healthySample, { ...healthySample, phase: 'resumed', video: {
        ...healthySample.video, currentTime: 20,
      } }],
      rendererValidation: { status: 'observed' },
      playerControl: { status: 'observed' },
      resumeAccessibleRender: { status: 'observed' },
      pageErrorTypes: [],
      unexpectedConsoleErrors: 0,
    });

    expect(reasons).toContain('native-hidden-transition-unverified');
  });

  it('rejects samples with unhealthy or non-progressing media', () => {
    const unhealthy = {
      ...healthySample,
      video: { ...healthySample.video, errorCode: 3, paused: true },
    };
    const health = durationModule.summarizePhaseHealth(
      [unhealthy, { ...unhealthy, video: { ...unhealthy.video, currentTime: 10 } }],
      'active'
    );

    expect(health.status).toBe('unverified');
    expect(health.reasons).toEqual(expect.arrayContaining([
      'sample-health-incomplete',
      'media-time-not-progressing',
    ]));
  });

  it('records visible YouTube player error UI even when MediaError is null', () => {
    const errorUiSample = {
      ...healthySample,
      playerErrorUi: { visible: true, marker: 'youtube-player-error-ui-visible' },
    };
    const health = durationModule.summarizePhaseHealth([
      errorUiSample,
      {
        ...errorUiSample,
        video: { ...errorUiSample.video, currentTime: 40 },
      },
    ], 'active');

    expect(health).toMatchObject({
      status: 'unverified',
      healthySampleCount: 0,
      reasons: ['sample-health-incomplete'],
    });
  });

  it.each([
    { name: 'normal increase', times: [10, 40, 70], range: 60 },
    { name: 'stalled playback', times: [10, 10, 10], range: 0 },
    {
      name: 'timeline reset after a player error',
      times: [46788.115483, 46818.165862, 0, 0],
      range: 46818.165862,
    },
    { name: 'forward seek', times: [10, 3610], range: 3600 },
    { name: 'one position', times: [10], range: null },
    { name: 'no positions', times: [], range: null },
    { name: 'non-finite positions', times: [10, Number.NaN, Infinity], range: null },
  ])('reports only a media position range for $name', ({ times, range }) => {
    const health = durationModule.summarizePhaseHealth(times.map((currentTime) => ({
      ...healthySample,
      video: { ...healthySample.video, currentTime },
    })), 'active');

    expect(health.mediaTimeRangeSeconds).toBe(range);
    expect(health).not.toHaveProperty('mediaProgressSeconds');
  });

  it('keeps the recorded player-error timeline reset unverified', () => {
    const samples = [46788.115483, 46818.165862, 0, 0].map((currentTime, index) => ({
      ...healthySample,
      playerErrorUi: { visible: index >= 2 },
      video: {
        ...healthySample.video,
        currentTime,
        paused: index >= 2,
        readyState: index >= 2 ? 0 : 4,
      },
    }));

    expect(durationModule.summarizePhaseHealth(samples, 'active')).toMatchObject({
      status: 'unverified',
      healthySampleCount: 2,
      nonProgressingIntervalCount: 2,
      mediaTimeRangeSeconds: 46818.165862,
      reasons: ['sample-health-incomplete', 'media-time-not-progressing'],
    });
  });

  it('waits for both overlay surfaces after healthy media becomes ready', () => {
    expect(durationModule.isInitialObservationReady({
      ...healthySample,
      canvasAttached: false,
      installedBridgeReady: false,
    })).toBe(false);
    expect(durationModule.isInitialObservationReady({
      ...healthySample,
      installedBridgeReady: false,
    })).toBe(false);
    expect(durationModule.isInitialObservationReady({
      ...healthySample,
      canvasAttached: false,
    })).toBe(false);
    expect(durationModule.isInitialObservationReady(healthySample)).toBe(true);
    expect(durationModule.isInitialObservationReady({
      ...healthySample,
      playerErrorUi: { visible: true, marker: 'youtube-player-error-ui-visible' },
    })).toBe(false);
  });

  it('requires a fresh accessible fingerprint after resume when chat exists', () => {
    expect(durationModule.classifyResumeFingerprint(
      { count: 2, fingerprint: 'before' },
      { count: 2, fingerprint: 'after' },
      123
    )).toMatchObject({ status: 'observed', fingerprintChanged: true });

    expect(durationModule.classifyResumeFingerprint(
      { count: 2, fingerprint: 'same' },
      { count: 2, fingerprint: 'same' },
      123
    )).toMatchObject({ status: 'unverified', reason: 'accessible-render-did-not-change' });

    expect(durationModule.classifyResumeFingerprint(
      { count: 0, fingerprint: 'empty' },
      { count: 0, fingerprint: 'empty' },
      123
    )).toMatchObject({ status: 'not-run', reason: 'no-accessible-chat-observed' });
  });

  it('does not await a never-settling media play promise', async () => {
    const video: {
      currentTime: number;
      error: null;
      muted: boolean;
      pause: () => void;
      paused: boolean;
      play: () => Promise<void>;
      readyState: number;
    } = {
      currentTime: 42,
      error: null,
      muted: false,
      pause: () => undefined,
      paused: false,
      play: () => Promise.resolve(),
      readyState: 4,
    };
    const pause = vi.fn(() => {
      video.paused = true;
    });
    const play = vi.fn(() => {
      video.paused = false;
      return new Promise<void>(() => {});
    });
    video.pause = pause;
    video.play = play;
    const locator = {
      evaluate: vi.fn(async (callback: (element: typeof video) => unknown) => callback(video)),
    };
    const page = { locator: () => ({ first: () => locator }) };

    await expect(durationModule.exercisePlayerPausePlay(page, {
      delay: vi.fn().mockResolvedValue(undefined),
      timeoutMs: 50,
    })).resolves.toMatchObject({ status: 'observed', muted: true });
    expect(pause).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });
});

describe('natural Chrome ownership boundaries', () => {
  it('retains the owned profile when only direct child exit can be established', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-natural-cleanup-'));
    const profile = join(root, 'chrome-install-unidentified');
    await mkdir(profile);
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    const waitForChildExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    try {
      const result = await naturalChromeModule.cleanupFailedNaturalChrome({
        child,
        childState: { spawnError: null },
        browserProcessIdentity: null,
        profile,
        root,
      }, {
        stopChild: (ownedChild: unknown, state: unknown, cdp: unknown) =>
          naturalChromeModule.stopUnidentifiedChild(ownedChild, state, cdp, {
            waitForChildExit,
          }),
      });

      expect(child.kill).toHaveBeenCalledOnce();
      expect(result.cleanup).toMatchObject({
        directChildExited: true,
        processIdentityCaptured: false,
        processTreeExited: false,
        profilePreserved: true,
        profileRemovalFailed: false,
        profileRemoved: false,
      });
      expect(result.errors).toHaveLength(1);
      await expect(stat(profile)).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates an identity-checked process tree before removing its profile', async () => {
    const ordering: string[] = [];
    const identity = {
      processId: 42,
      creationDate: '20260912120000.000000+000',
      commandLine: 'chrome.exe --user-data-dir=C:\\owned-profile',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      profile: 'c:\\owned-profile',
    };
    const result = await naturalChromeModule.cleanupFailedNaturalChrome({
      child: { pid: 42 },
      childState: { spawnError: null },
      browserProcessIdentity: identity,
      profile: 'C:\\owned-profile',
      root: 'C:\\',
    }, {
      terminateProcessTree: vi.fn(async (value: unknown) => {
        expect(value).toBe(identity);
        ordering.push('terminate-tree');
      }),
      removeProfile: vi.fn(async () => {
        ordering.push('remove-profile');
      }),
    });

    expect(ordering).toEqual(['terminate-tree', 'remove-profile']);
    expect(result).toEqual({
      cleanup: {
        directChildExited: false,
        processIdentityCaptured: true,
        processTreeExited: true,
        profilePreserved: false,
        profileRemovalFailed: false,
        profileRemoved: true,
      },
      errors: [],
    });
  });

  it('removes the profile when asynchronous spawn failure proves no PID existed', async () => {
    const ordering: string[] = [];
    const spawnError = new Error('spawn failed');
    const result = await naturalChromeModule.cleanupFailedNaturalChrome({
      child: { pid: undefined },
      childState: { spawnError },
      browserProcessIdentity: null,
      profile: 'C:\\owned-profile',
      root: 'C:\\',
    }, {
      stopChild: vi.fn(async () => {
        ordering.push('confirm-no-process');
        return { exited: true, errors: [] };
      }),
      removeProfile: vi.fn(async () => {
        ordering.push('remove-profile');
      }),
    });

    expect(ordering).toEqual(['confirm-no-process', 'remove-profile']);
    expect(result.cleanup).toMatchObject({
      processIdentityCaptured: false,
      processTreeExited: true,
      profilePreserved: false,
      profileRemovalFailed: false,
      profileRemoved: true,
    });
    expect(result.errors).toEqual([]);
  });

  it('always launches the owned natural browser muted on loopback DevTools', () => {
    expect(naturalChromeModule.naturalChromeArguments('C:\\owned-profile')).toEqual(
      expect.arrayContaining([
        '--mute-audio',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--user-data-dir=C:\\owned-profile',
      ])
    );
  });
});
