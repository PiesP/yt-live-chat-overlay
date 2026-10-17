// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  captureFailurePlayerDom,
  readPublicDurationPageState,
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
    const page = { evaluate: vi.fn(async (fn: () => unknown) => fn()) } as unknown as Page;

    const captured = await captureFailurePlayerDom(page);

    expect(captured).toMatchObject({
      playerFound: true,
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
});
