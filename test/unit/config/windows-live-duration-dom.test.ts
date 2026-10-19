// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  captureFailurePlayerDom,
  exercisePlayerPausePlay,
  observePublicVideo,
  readPublicDurationPageState,
  runLiveDuration,
} from '../../../validation/windows/live-duration.ts';

const fixture = readFileSync(
  resolve(process.cwd(), 'test/unit/config/fixtures/youtube-unplayable-player.html'),
  'utf8'
);

function showLayout(): void {
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return this.closest('[style*="display: none"]')
      ? ([] as unknown as DOMRectList)
      : ([{}] as unknown as DOMRectList);
  });
}

function ownedVideo(): HTMLVideoElement {
  const video = document.querySelector('#movie_player video');
  if (!(video instanceof HTMLVideoElement)) throw new Error('Missing test video');
  return video;
}

function ownedPlayer(): Element {
  const player = document.querySelector('#movie_player');
  if (!player) throw new Error('Missing test player');
  return player;
}

function domBinding(
  video = ownedVideo(),
  player = ownedPlayer()
): { player: Element; video: HTMLVideoElement } {
  return { player, video };
}

function mockPage(): Page {
  return {
    evaluate: vi.fn(async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)),
  } as unknown as Page;
}

function mockBinding(
  video: HTMLVideoElement,
  player = ownedPlayer()
): Parameters<typeof exercisePlayerPausePlay>[0] {
  const videoHandle = Object.assign(video, {
    evaluate: vi.fn(async (fn: typeof observePublicVideo, argument: Parameters<typeof fn>[1]) =>
      fn(video, { ...argument, player })
    ),
  });
  return {
    player,
    video: videoHandle,
  } as unknown as Parameters<typeof exercisePlayerPausePlay>[0];
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public duration player-error DOM probe', () => {
  it('finds the visible captured provider error with no MediaError', () => {
    document.body.innerHTML = fixture;
    showLayout();

    const state = readPublicDurationPageState();

    expect(state.video?.errorCode).toBeNull();
    expect(state.playerErrorUi).toEqual({
      visible: true,
      marker: 'youtube-playability-error-ui-visible',
    });
  });

  it('ignores a hidden provider error and hidden player controls', () => {
    document.body.innerHTML = fixture;
    document.querySelector('#player')?.setAttribute('style', 'display: none');
    showLayout();

    expect(readPublicDurationPageState().playerErrorUi).toEqual({
      visible: false,
      marker: null,
    });
  });

  it('ignores a provider marker without layout boxes', () => {
    document.body.innerHTML = fixture;
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
      () => [] as unknown as DOMRectList
    );

    expect(readPublicDurationPageState().playerErrorUi).toEqual({
      visible: false,
      marker: null,
    });
  });

  it('continues to recognize the old visible player-error UI', () => {
    document.body.innerHTML = '<div id="movie_player"><div class="ytp-error"></div></div>';
    showLayout();

    expect(readPublicDurationPageState().playerErrorUi).toEqual({
      visible: true,
      marker: 'youtube-player-error-ui-visible',
    });
  });

  it('does not invent an error when media and error UI are absent', () => {
    document.body.innerHTML = '<div id="player"></div>';
    showLayout();

    const state = readPublicDurationPageState();
    expect(state.video).toBeNull();
    expect(state.playerErrorUi).toEqual({ visible: false, marker: null });
  });

  it('retains bounded provider and media diagnostics from the captured structure', async () => {
    document.body.innerHTML = fixture;
    showLayout();
    vi.stubGlobal('ytInitialPlayerResponse', {
      playabilityStatus: {
        status: 'UNPLAYABLE',
        reason: 'This live stream recording is not available.',
      },
    });
    const page = mockPage();

    const captured = await captureFailurePlayerDom(
      page,
      domBinding() as unknown as Parameters<typeof captureFailurePlayerDom>[1]
    );

    expect(captured).toMatchObject({
      playerFound: true,
      providerStatusSource: 'ytInitialPlayerResponse-initial',
      mediaIdentity: 'owned',
      providerStatus: 'UNPLAYABLE',
      providerReason: 'This live stream recording is not available.',
      mediaNetworkState: 0,
      mediaErrorCode: null,
    });
    expect(captured.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorText: 'Video unavailable',
          path: expect.arrayContaining([expect.objectContaining({ visible: true })]),
        }),
      ])
    );
  });

  it.each([false, true])('reads the owned mute state %s without a write', (muted) => {
    document.body.innerHTML = fixture;
    const video = ownedVideo();
    let actualMuted = muted;
    const setter = vi.fn((value: boolean) => {
      actualMuted = value;
    });
    Object.defineProperty(video, 'muted', { get: () => actualMuted, set: setter });

    expect(readPublicDurationPageState(domBinding(video)).video?.muted).toBe(muted);
    expect(observePublicVideo(video, { player: ownedPlayer(), action: 'read' }).after.muted).toBe(
      muted
    );
    expect(setter).not.toHaveBeenCalled();
  });

  it('reads the owned player video without muting or playing another video', async () => {
    document.body.innerHTML = `<video id="unrelated"></video>${fixture}`;
    const video = ownedVideo();
    video.muted = false;
    const unrelated = document.querySelector('#unrelated') as HTMLVideoElement;
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    const otherPlay = vi.spyOn(unrelated, 'play').mockResolvedValue();

    expect(readPublicDurationPageState(domBinding(video)).video?.muted).toBe(false);
    const action = observePublicVideo(video, { player: ownedPlayer(), action: 'read' });
    expect(action).toMatchObject({ before: { muted: false }, after: { muted: false } });
    expect(play).not.toHaveBeenCalled();
    expect(otherPlay).not.toHaveBeenCalled();
    expect(unrelated.muted).toBe(false);
  });

  it('rejects ambiguous, replaced, disconnected, and foreign-document owned videos', () => {
    document.body.innerHTML = fixture;
    const video = ownedVideo();
    const player = video.parentElement;
    if (!player) throw new Error('Missing test player');

    player.appendChild(document.createElement('video'));
    expect(() => readPublicDurationPageState(domBinding(video, player))).toThrow(
      /ambiguous|replaced/u
    );
    expect(() => observePublicVideo(video, { player, action: 'pause' })).toThrow(
      /ambiguous|replaced/u
    );
    player.lastElementChild?.remove();

    const secondPlayer = document.createElement('div');
    secondPlayer.id = 'movie_player';
    document.body.appendChild(secondPlayer);
    expect(() => readPublicDurationPageState(domBinding(video, player))).toThrow(
      /ambiguous|replaced/u
    );
    secondPlayer.remove();

    const replacement = document.createElement('video');
    video.replaceWith(replacement);
    expect(() => readPublicDurationPageState(domBinding(video, player))).toThrow(
      /ambiguous|replaced/u
    );
    expect(() => observePublicVideo(video, { player, action: 'play' })).toThrow(
      /ambiguous|replaced/u
    );
    expect(() => readPublicDurationPageState(domBinding(replacement, player)).video).not.toBeNull();

    replacement.remove();
    expect(() => readPublicDurationPageState(domBinding(replacement, player))).toThrow(
      /ambiguous|replaced/u
    );
    const foreignDocument = document.implementation.createHTMLDocument();
    const foreign = foreignDocument.createElement('video');
    foreignDocument.body.appendChild(foreign);
    expect(() => readPublicDurationPageState(domBinding(foreign, player))).toThrow(
      /ambiguous|replaced/u
    );
  });

  it('rejects the same video moved into a replacement sole player', async () => {
    document.body.innerHTML = fixture;
    const video = ownedVideo();
    const originalPlayer = video.closest('#movie_player');
    if (!originalPlayer) throw new Error('Missing test player');
    const replacementPlayer = document.createElement('div');
    replacementPlayer.id = 'movie_player';
    originalPlayer.replaceWith(replacementPlayer);
    replacementPlayer.appendChild(video);
    const play = vi.spyOn(video, 'play').mockResolvedValue();

    expect(() => readPublicDurationPageState(domBinding(video, originalPlayer))).toThrow(
      /ambiguous|replaced/u
    );
    expect(() => observePublicVideo(video, { player: originalPlayer, action: 'read' })).toThrow(
      /ambiguous|replaced/u
    );
    expect(() => observePublicVideo(video, { player: originalPlayer, action: 'read' })).toThrow(
      /ambiguous|replaced/u
    );
    expect(play).not.toHaveBeenCalled();
    const captured = await captureFailurePlayerDom(
      mockPage(),
      domBinding(video, originalPlayer) as unknown as Parameters<typeof captureFailurePlayerDom>[1]
    );
    expect(captured.mediaIdentity).toBe('unavailable');
  });

  it('keeps DOM pause/play bounded and does not repair a mute drift', async () => {
    document.body.innerHTML = fixture;
    const video = ownedVideo();
    video.muted = true;
    let paused = false;
    Object.defineProperty(video, 'paused', { get: () => paused });
    Object.defineProperty(video, 'readyState', { get: () => 4 });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const play = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return new Promise<void>(() => {});
    });
    const handle = mockBinding(video);

    const control = await exercisePlayerPausePlay(handle, {
      delay: vi.fn().mockResolvedValue(undefined),
      timeoutMs: 50,
    });
    expect(control).toMatchObject({
      status: 'observed',
      before: { muted: true, paused: false },
      pauseAction: { before: { paused: false }, after: { paused: true } },
      playAction: { before: { paused: true }, after: { paused: false } },
      muted: true,
    });
    expect(pause).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();

    video.muted = false;
    await expect(exercisePlayerPausePlay(handle)).rejects.toThrow(/not ready/u);
    expect(video.muted).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('rejects mute drift during resume without writing it back', async () => {
    document.body.innerHTML = fixture;
    const video = ownedVideo();
    video.muted = true;
    let paused = false;
    Object.defineProperty(video, 'paused', { get: () => paused });
    Object.defineProperty(video, 'readyState', { get: () => 4 });
    vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      video.muted = false;
      return Promise.resolve();
    });
    const handle = mockBinding(video);

    await expect(
      exercisePlayerPausePlay(handle, {
        delay: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 10,
      })
    ).rejects.toThrow(/bounded playback state/u);
    expect(video.muted).toBe(false);
  });

  it('stops control actions when pause disconnects the owned video', async () => {
    document.body.innerHTML = fixture;
    const video = ownedVideo();
    video.muted = true;
    Object.defineProperty(video, 'paused', { get: () => false });
    Object.defineProperty(video, 'readyState', { get: () => 4 });
    vi.spyOn(video, 'pause').mockImplementation(() => video.remove());
    const play = vi.spyOn(video, 'play').mockResolvedValue();

    await expect(exercisePlayerPausePlay(mockBinding(video))).rejects.toThrow(
      /ambiguous|replaced/u
    );
    expect(play).not.toHaveBeenCalled();
  });

  it('keeps failure media bound to the original video after replacement', async () => {
    document.body.innerHTML = fixture;
    const video = ownedVideo();
    video.replaceWith(document.createElement('video'));

    const captured = await captureFailurePlayerDom(
      mockPage(),
      domBinding(video) as unknown as Parameters<typeof captureFailurePlayerDom>[1]
    );
    expect(captured).toMatchObject({
      providerStatusSource: 'ytInitialPlayerResponse-initial',
      mediaIdentity: 'unavailable',
      mediaNetworkState: null,
      mediaErrorCode: null,
    });
  });

  it.each(['disconnected', 'moved to a replacement player'])(
    'records %s ownership loss and disposes both fixed handles',
    async (failureMode) => {
      document.body.innerHTML = fixture;
      const video = ownedVideo();
      const player = ownedPlayer();
      const disposeVideo = vi.fn().mockResolvedValue(undefined);
      const disposePlayer = vi.fn().mockResolvedValue(undefined);
      const closePage = vi.fn().mockResolvedValue(undefined);
      const closeBackground = vi.fn().mockResolvedValue(undefined);
      const binding = mockBinding(video, player);
      Object.assign(video, { dispose: disposeVideo });
      Object.assign(player, { dispose: disposePlayer });
      const page = {
        on: vi.fn(),
        bringToFront: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        getByRole: vi.fn(() => ({ isVisible: vi.fn().mockResolvedValue(false) })),
        locator: vi.fn((selector: string) =>
          selector === '#movie_player'
            ? {
                waitFor: vi.fn().mockResolvedValue(undefined),
                elementHandle: vi.fn().mockResolvedValue(binding.player),
              }
            : { elementHandle: vi.fn().mockResolvedValue(binding.video) }
        ),
        evaluate: vi.fn(async (fn: (argument: unknown) => unknown, argument: unknown) => {
          if (fn === readPublicDurationPageState && player.isConnected) {
            if (failureMode === 'disconnected') {
              video.remove();
            } else {
              const replacement = document.createElement('div');
              replacement.id = 'movie_player';
              player.replaceWith(replacement);
              replacement.appendChild(video);
            }
          }
          return fn(argument);
        }),
        isClosed: vi.fn(() => false),
        screenshot: vi.fn().mockResolvedValue(undefined),
        close: closePage,
      };
      const context = {
        newPage: vi
          .fn()
          .mockResolvedValueOnce(page)
          .mockResolvedValueOnce({ close: closeBackground }),
      } as unknown as BrowserContext;
      const output = await mkdtemp(join(tmpdir(), 'yt-duration-ownership-'));
      try {
        await expect(
          runLiveDuration({ context, url: 'https://www.youtube.com/watch?v=public', output })
        ).rejects.toThrow(
          'Duration observation failed during preflight:wait-native-mute-precondition'
        );
        const result = JSON.parse(
          await readFile(join(output, 'live-duration-result.json'), 'utf8')
        );
        expect(result).toMatchObject({
          status: 'failed',
          evidenceStatus: 'unverified',
          failureState: null,
          failurePlayerDom: { mediaIdentity: 'unavailable', mediaNetworkState: null },
          failures: [
            {
              stage: 'preflight:wait-native-mute-precondition',
              reason: 'owned-public-video-lost',
            },
          ],
        });
        expect(disposeVideo).toHaveBeenCalledOnce();
        expect(disposePlayer).toHaveBeenCalledOnce();
        expect(closePage).toHaveBeenCalledOnce();
        expect(closeBackground).toHaveBeenCalledOnce();
        expect(binding.video.evaluate).not.toHaveBeenCalled();
      } finally {
        await rm(output, { recursive: true, force: true });
      }
    }
  );
});
