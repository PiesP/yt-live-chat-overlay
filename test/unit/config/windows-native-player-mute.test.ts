// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=native-abc"}

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
  createNativeMuteBoundary,
  establishOwnedMute,
  type inspectBoundNativeMuteButton,
  playOwnedMutedVideo,
} from '../../../validation/windows/native-player-mute.ts';

const ID = 'native-abc';

function setup(muted = false) {
  document.body.innerHTML = `<div id="movie_player"><video></video><div class="ytp-mute-button">
    <button class="ytp-volume-icon ytp-button" aria-keyshortcuts="m"></button>
    </div></div>`;
  const player = document.querySelector('#movie_player');
  const video = document.querySelector('#movie_player video');
  const button = document.querySelector('#movie_player button');
  if (
    !(player instanceof Element) ||
    !(video instanceof HTMLVideoElement) ||
    !(button instanceof HTMLButtonElement)
  )
    throw new Error('Missing native mute fixture');
  Object.assign(player, { getVideoData: () => ({ video_id: ID }) });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => button),
  });
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    width: 30,
    height: 30,
  } as DOMRect);
  video.muted = muted;
  button.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  button.setAttribute('title', muted ? 'Unmute' : 'Mute');
  let clicks = 0;
  button.addEventListener('click', () => {
    clicks++;
    video.muted = true;
    button.setAttribute('aria-label', 'Unmute');
    button.setAttribute('title', 'Unmute');
  });
  return { player, video, button, clicks: () => clicks };
}

function mockedAction(fixture: ReturnType<typeof setup>) {
  const hover = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn().mockResolvedValue(undefined);
  const click = vi.fn(async () => fixture.button.click());
  const buttonHandle = {
    evaluate: vi.fn(
      async (fn: typeof inspectBoundNativeMuteButton, args: { expectedVideoId: string }) =>
        fn(fixture.button, {
          player: fixture.player,
          video: fixture.video,
          expectedVideoId: args.expectedVideoId,
        })
    ),
    click,
    dispose,
  };
  const muteLocator = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(1),
    elementHandle: vi.fn().mockResolvedValue(buttonHandle),
  };
  const playerLocator = {
    getByRole: vi.fn((_role: string, { name }: { name: RegExp }) => ({
      waitFor: vi.fn(async () => {
        if (!name.test(fixture.button.getAttribute('aria-label') ?? '')) {
          throw new Error('Native Unmute label absent');
        }
      }),
    })),
  };
  const page = {
    locator: vi.fn((selector: string) =>
      selector === '#movie_player' ? playerLocator : muteLocator
    ),
  } as unknown as Page;
  const binding = {
    player: { hover },
    video: {},
  } as unknown as Parameters<typeof establishOwnedMute>[0]['binding'];
  const controller = { timedOut: false, pendingUncertain: 0, lateSettlements: 0 };
  const bounded = createNativeMuteBoundary({ deadlineMs: performance.now() + 10_000, controller });
  return { page, binding, bounded, buttonHandle, click, dispose, hover, controller };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('one retained native mute control', () => {
  it('persists the sole click intent first, then proves Unmute and the same muted video', async () => {
    const fixture = setup(false);
    const action = mockedAction(fixture);
    const order: string[] = [];
    action.click.mockImplementation(async () => {
      order.push('click');
      fixture.button.click();
    });
    const beforeClick = vi.fn(async () => {
      order.push('intent-persisted');
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
    expect(order).toEqual(['intent-persisted', 'click']);
    expect(action.hover).toHaveBeenCalledOnce();
    expect(action.click).toHaveBeenCalledOnce();
    expect(action.dispose).toHaveBeenCalledOnce();
    expect(fixture.clicks()).toBe(1);
  });

  it('accepts an already muted retained video without another click', async () => {
    const fixture = setup(true);
    const action = mockedAction(fixture);
    const beforeClick = vi.fn();
    const result = await establishOwnedMute({ ...action, expectedVideoId: ID, beforeClick });
    expect(result).toMatchObject({
      method: 'already-muted',
      clickIssued: false,
      after: { muted: true },
    });
    expect(action.click).not.toHaveBeenCalled();
    expect(beforeClick).not.toHaveBeenCalled();
  });

  it('rejects wrong identity, ad, conflicting label, overlay hit and replacement before click', async () => {
    const failures = [
      (fixture: ReturnType<typeof setup>) =>
        Object.assign(fixture.player, { getVideoData: () => ({ video_id: 'other' }) }),
      (fixture: ReturnType<typeof setup>) => fixture.player.classList.add('ad-showing'),
      (fixture: ReturnType<typeof setup>) => fixture.button.setAttribute('aria-label', 'Unmute'),
      () =>
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: () => document.body,
        }),
      (fixture: ReturnType<typeof setup>) =>
        fixture.button.replaceWith(document.createElement('button')),
    ];
    for (const corrupt of failures) {
      const fixture = setup(false);
      corrupt(fixture);
      const action = mockedAction(fixture);
      await expect(
        establishOwnedMute({ ...action, expectedVideoId: ID, beforeClick: vi.fn() })
      ).rejects.toThrow();
      expect(action.click).not.toHaveBeenCalled();
      expect(action.dispose).toHaveBeenCalledOnce();
    }
  });

  it('does not issue a click when the before-click receipt fails', async () => {
    const fixture = setup(false);
    const action = mockedAction(fixture);
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
  });

  it('keeps a timeout uncertain and blocks any subsequent action after late settlement', async () => {
    const controller = { timedOut: false, pendingUncertain: 0, lateSettlements: 0 };
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

  it('guards owned play after mute proof and never writes the mute property', () => {
    const fixture = setup(true);
    const play = vi.spyOn(fixture.video, 'play').mockResolvedValue();
    const action = playOwnedMutedVideo(fixture.video, {
      player: fixture.player,
      expectedVideoId: ID,
    });
    expect(action).toMatchObject({
      action: 'play',
      before: { muted: true },
      after: { muted: true },
    });
    expect(play).toHaveBeenCalledOnce();
    fixture.video.muted = false;
    expect(() =>
      playOwnedMutedVideo(fixture.video, {
        player: fixture.player,
        expectedVideoId: ID,
      })
    ).toThrow(/lost verified mute/u);
    expect(play).toHaveBeenCalledOnce();
  });

  it('the duration caller persists one native click and rejects mute drift during readiness', async () => {
    const fixture = setup(false);
    const action = mockedAction(fixture);
    const playerHandle = Object.assign(fixture.player, {
      hover: action.hover,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const play = vi.spyOn(fixture.video, 'play').mockResolvedValue();
    const videoHandle = Object.assign(fixture.video, {
      evaluate: vi.fn(async (fn: typeof playOwnedMutedVideo, args: { expectedVideoId: string }) =>
        fn(fixture.video, {
          player: fixture.player,
          expectedVideoId: args.expectedVideoId,
        })
      ),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    let stateReads = 0;
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
            getByRole: vi.fn((_role: string, { name }: { name: RegExp }) => ({
              waitFor: vi.fn(async () => {
                if (!name.test(fixture.button.getAttribute('aria-label') ?? '')) {
                  throw new Error('Native Unmute label absent');
                }
              }),
            })),
          };
        if (selector === '#movie_player video')
          return {
            elementHandle: vi.fn().mockResolvedValue(videoHandle),
          };
        return {
          waitFor: vi.fn().mockResolvedValue(undefined),
          count: vi.fn().mockResolvedValue(1),
          elementHandle: vi.fn().mockResolvedValue(action.buttonHandle),
        };
      }),
      evaluate: vi.fn(async (fn: (argument: unknown) => unknown, argument: unknown) => {
        if (fn === readPublicDurationPageState && ++stateReads === 2) fixture.video.muted = false;
        return fn(argument);
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
      expect(play).toHaveBeenCalledOnce();
      expect(fixture.video.muted).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
