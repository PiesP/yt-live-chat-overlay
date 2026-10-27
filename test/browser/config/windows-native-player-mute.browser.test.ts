// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  inspectBoundNativeMuteButton,
  playOwnedMutedVideo,
} from '../../../validation/windows/native-mute-page.ts';

const ID = 'native-abc';
const WATCH_URL = `https://www.youtube.com/watch?v=${ID}`;

function setup(muted = false) {
  document.body.innerHTML = `<div id="movie_player"><video></video><div class="ytp-mute-button">
    <button class="ytp-volume-icon ytp-button" aria-keyshortcuts="m" style="position:fixed;left:10px;top:20px;width:30px;height:30px;z-index:1"></button>
    </div></div>`;
  const player = document.querySelector('#movie_player');
  const video = document.querySelector('#movie_player video');
  const button = document.querySelector('#movie_player button');
  if (
    !(player instanceof Element) ||
    !(video instanceof HTMLVideoElement) ||
    !(button instanceof HTMLButtonElement)
  ) {
    throw new Error('Missing native mute fixture');
  }
  Object.assign(player, { getVideoData: () => ({ video_id: ID }) });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
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

function inspect(fixture: ReturnType<typeof setup>, currentUrl = WATCH_URL) {
  return inspectBoundNativeMuteButton(fixture.button, {
    player: fixture.player,
    video: fixture.video,
    expectedVideoId: ID,
    currentUrl,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('retained native mute control in Chromium', () => {
  it('proves the sole actionable Mute button and the same Unmute state after one click', () => {
    const fixture = setup();
    expect(inspect(fixture)).toMatchObject({ decision: 'click-mute', muted: false });
    fixture.button.click();
    expect(inspect(fixture)).toMatchObject({ decision: 'already-muted', muted: true });
    expect(fixture.clicks()).toBe(1);
    expect(document.elementFromPoint(25, 35)).toBe(fixture.button);
  });

  it('accepts an already muted retained video without a click', () => {
    const fixture = setup(true);
    expect(inspect(fixture)).toMatchObject({ decision: 'already-muted', muted: true });
    expect(fixture.clicks()).toBe(0);
  });

  it('rejects wrong identity, ad, conflicting label, covered button, and replaced button', () => {
    const failures = [
      (f: ReturnType<typeof setup>) =>
        Object.assign(f.player, { getVideoData: () => ({ video_id: 'other' }) }),
      (f: ReturnType<typeof setup>) => f.player.classList.add('ad-showing'),
      (f: ReturnType<typeof setup>) => f.button.setAttribute('aria-label', 'Unmute'),
      () => {
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;left:10px;top:20px;width:30px;height:30px;z-index:2';
        document.body.appendChild(cover);
      },
      (f: ReturnType<typeof setup>) => f.button.replaceWith(document.createElement('button')),
    ];
    for (const corrupt of failures) {
      const fixture = setup();
      corrupt(fixture);
      expect(() => inspect(fixture)).toThrow();
      expect(fixture.clicks()).toBe(0);
    }
  });

  it('rejects a foreign origin and another video identity', () => {
    const fixture = setup();
    expect(() => inspect(fixture, `https://example.com/watch?v=${ID}`)).toThrow(
      'Native mute precondition is unverified'
    );
    expect(() => inspect(fixture, 'https://www.youtube.com/watch?v=other')).toThrow(
      'Native mute precondition is unverified'
    );
  });

  it('plays only after mute proof and never repairs mute drift', () => {
    const fixture = setup(true);
    const play = vi.spyOn(fixture.video, 'play').mockResolvedValue();
    const args = { player: fixture.player, expectedVideoId: ID, currentUrl: WATCH_URL };
    expect(playOwnedMutedVideo(fixture.video, args)).toMatchObject({
      action: 'play',
      before: { muted: true },
      after: { muted: true },
    });
    expect(play).toHaveBeenCalledOnce();
    fixture.video.muted = false;
    expect(() => playOwnedMutedVideo(fixture.video, args)).toThrow(/lost verified mute/u);
    expect(play).toHaveBeenCalledOnce();
  });
});
