// SPDX-License-Identifier: MIT

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

    for (const invalid of [
      undefined,
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
  it('uses only direct child termination before browser identity exists', async () => {
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    const waitForChildExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const browserCdp = { send: vi.fn() };

    await expect(naturalChromeModule.stopUnidentifiedChild(
      child,
      { spawnError: null },
      null,
      { waitForChildExit }
    )).resolves.toEqual({ exited: true, errors: [] });

    expect(child.kill).toHaveBeenCalledOnce();
    expect(browserCdp.send).not.toHaveBeenCalled();
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
