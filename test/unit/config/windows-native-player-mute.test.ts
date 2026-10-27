// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { BrowserContext, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  readPublicDurationPageState,
  runLiveDuration,
} from '../../../validation/windows/live-duration.ts';
import {
  inspectBoundNativeMuteButton,
  playOwnedMutedVideo,
} from '../../../validation/windows/native-mute-page.ts';
import {
  createNativeMuteBoundary,
  establishOwnedMute,
  type NativeMuteBoundary,
} from '../../../validation/windows/native-player-mute.ts';

const ID = 'native-abc';

function actionFixture(initiallyMuted = false) {
  let muted = initiallyMuted;
  let readCount = 0;
  const order: string[] = [];
  const hover = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn().mockResolvedValue(undefined);
  const click = vi.fn(async () => {
    order.push('click');
    muted = true;
  });
  const buttonHandle = {
    evaluate: vi.fn(async (fn: typeof inspectBoundNativeMuteButton) => {
      expect(fn).toBe(inspectBoundNativeMuteButton);
      readCount++;
      return {
        decision: muted ? ('already-muted' as const) : ('click-mute' as const),
        muted,
        paused: true,
        readyState: 4,
        currentTime: 0,
      };
    }),
    click,
    dispose,
  };
  const muteLocator = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(1),
    elementHandle: vi.fn().mockResolvedValue(buttonHandle),
  };
  const playerLocator = {
    getByRole: vi.fn(() => ({ waitFor: vi.fn().mockResolvedValue(undefined) })),
  };
  const page = {
    locator: vi.fn((selector: string) =>
      selector === '#movie_player' ? playerLocator : muteLocator
    ),
  } as unknown as Page;
  const binding = { player: { hover }, video: {} } as unknown as Parameters<
    typeof establishOwnedMute
  >[0]['binding'];
  const controller: NativeMuteBoundary = {
    timedOut: false,
    pendingUncertain: 0,
    lateSettlements: 0,
  };
  const bounded = createNativeMuteBoundary({ deadlineMs: performance.now() + 10_000, controller });
  return {
    page,
    binding,
    bounded,
    buttonHandle,
    click,
    dispose,
    hover,
    order,
    controller,
    muted: () => muted,
    readCount: () => readCount,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('native mute orchestration', () => {
  it('persists the sole click intent before the click and proves the retained state', async () => {
    const action = actionFixture();
    const beforeClick = vi.fn(async () => {
      action.order.push('intent-persisted');
    });
    const result = await establishOwnedMute({ ...action, expectedVideoId: ID, beforeClick });
    expect(result).toMatchObject({
      status: 'verified',
      method: 'click-mute',
      clickIssued: true,
      clickCompleted: true,
      before: { muted: false },
      after: { muted: true, decision: 'already-muted' },
    });
    expect(action.order).toEqual(['intent-persisted', 'click']);
    expect(action.hover).toHaveBeenCalledOnce();
    expect(action.buttonHandle.evaluate).toHaveBeenCalledTimes(3);
    expect(action.dispose).toHaveBeenCalledOnce();
  });

  it('accepts an already muted retained video without a click', async () => {
    const action = actionFixture(true);
    const beforeClick = vi.fn();
    const result = await establishOwnedMute({ ...action, expectedVideoId: ID, beforeClick });
    expect(result).toMatchObject({
      method: 'already-muted',
      clickIssued: false,
      after: { muted: true },
    });
    expect(action.click).not.toHaveBeenCalled();
    expect(beforeClick).not.toHaveBeenCalled();
    expect(action.dispose).toHaveBeenCalledOnce();
  });

  it('stops before the click when native page inspection rejects the retained control', async () => {
    const action = actionFixture();
    action.buttonHandle.evaluate.mockRejectedValueOnce(
      new Error('Native mute control is not uniquely actionable')
    );
    await expect(
      establishOwnedMute({ ...action, expectedVideoId: ID, beforeClick: vi.fn() })
    ).rejects.toThrow('not uniquely actionable');
    expect(action.click).not.toHaveBeenCalled();
    expect(action.dispose).toHaveBeenCalledOnce();
  });

  it('does not click when the before-click receipt fails', async () => {
    const action = actionFixture();
    await expect(
      establishOwnedMute({
        ...action,
        expectedVideoId: ID,
        beforeClick: async () => {
          throw new Error('receipt failed');
        },
      })
    ).rejects.toThrow('receipt failed');
    expect(action.click).not.toHaveBeenCalled();
    expect(action.dispose).toHaveBeenCalledOnce();
  });

  it('keeps a timeout uncertain and blocks subsequent actions after late settlement', async () => {
    const controller: NativeMuteBoundary = {
      timedOut: false,
      pendingUncertain: 0,
      lateSettlements: 0,
    };
    const bounded = createNativeMuteBoundary({ deadlineMs: performance.now() + 1_000, controller });
    let settle: (() => void) | undefined;
    await expect(
      bounded(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
        'native-click',
        5
      )
    ).rejects.toThrow('timed out');
    expect(controller.pendingUncertain).toBe(1);
    settle?.();
    await Promise.resolve();
    await Promise.resolve();
    const next = vi.fn();
    await expect(bounded(next, 'another-action')).rejects.toThrow('uncertain');
    expect(next).not.toHaveBeenCalled();
    expect(controller).toMatchObject({ timedOut: true, pendingUncertain: 0, lateSettlements: 1 });
  });

  it('records click intent and owned play before a later mute drift aborts readiness', async () => {
    const action = actionFixture();
    const playerHandle = { hover: action.hover, dispose: vi.fn().mockResolvedValue(undefined) };
    const videoEvaluate = vi.fn(async (fn: typeof playOwnedMutedVideo) => {
      expect(fn).toBe(playOwnedMutedVideo);
      return { action: 'play', before: { muted: true }, after: { muted: true } };
    });
    const videoHandle = { evaluate: videoEvaluate, dispose: vi.fn().mockResolvedValue(undefined) };
    let stateReads = 0;
    const healthyState = {
      visibility: 'visible',
      playerVideoId: ID,
      adShowing: false,
      playerErrorUi: { visible: false, marker: null },
      video: { currentTime: 0, errorCode: null, muted: false, paused: true, readyState: 4 },
      canvasAttached: false,
      installedBridgeReady: false,
    };
    const page = {
      on: vi.fn(),
      bringToFront: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      getByRole: vi.fn(() => ({ isVisible: vi.fn().mockResolvedValue(false) })),
      locator: vi.fn((selector: string) => {
        if (selector === '#movie_player')
          return {
            waitFor: vi.fn().mockResolvedValue(undefined),
            elementHandle: vi.fn().mockResolvedValue(playerHandle),
            getByRole: vi.fn(() => ({ waitFor: vi.fn().mockResolvedValue(undefined) })),
          };
        if (selector === '#movie_player video')
          return { elementHandle: vi.fn().mockResolvedValue(videoHandle) };
        return {
          waitFor: vi.fn().mockResolvedValue(undefined),
          count: vi.fn().mockResolvedValue(1),
          elementHandle: vi.fn().mockResolvedValue(action.buttonHandle),
        };
      }),
      evaluate: vi.fn(async (fn: unknown) => {
        if (fn === readPublicDurationPageState) {
          stateReads++;
          return {
            ...healthyState,
            video: { ...healthyState.video, muted: false },
          };
        }
        return {
          playerFound: true,
          mediaIdentity: 'unavailable',
          mediaNetworkState: null,
          mediaErrorCode: null,
          providerStatus: null,
          providerReason: null,
          candidates: [],
        };
      }),
      isClosed: vi.fn(() => false),
      screenshot: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi
        .fn()
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as BrowserContext;
    const output = await mkdtemp(join(tmpdir(), 'yt-duration-native-mute-'));
    try {
      await expect(
        runLiveDuration({ context, url: `https://www.youtube.com/watch?v=${ID}`, output })
      ).rejects.toThrow('Duration observation failed during preflight:wait-media-ready');
      const result = JSON.parse(await readFile(join(output, 'live-duration-result.json'), 'utf8'));
      expect(result.preflight).toMatchObject({
        nativeMuteClickIntent: { status: 'recorded-before-click' },
        startupControl: {
          status: 'verified',
          method: 'click-mute',
          clickIssued: true,
          clickCompleted: true,
        },
        initialOwnedPlay: { action: 'play', before: { muted: true }, after: { muted: true } },
      });
      expect(result.failures).toEqual(
        expect.arrayContaining([expect.objectContaining({ stage: 'preflight:wait-media-ready' })])
      );
      expect(result.status).toBe('failed');
      expect(action.click).toHaveBeenCalledOnce();
      expect(videoEvaluate).toHaveBeenCalledOnce();
      expect(stateReads).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
