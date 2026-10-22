// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { VideoPauseController } from '@app/video-pause-controller';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

function createVideo(paused: boolean): HTMLVideoElement {
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  Object.defineProperty(video, 'paused', {
    configurable: true,
    value: paused,
  });
  return video;
}

function setPictureInPictureVideo(video: HTMLVideoElement | null): void {
  Object.defineProperty(document, 'pictureInPictureElement', {
    configurable: true,
    value: video,
  });
}

describe('VideoPauseController', () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'pictureInPictureElement');
    document.body.replaceChildren();
  });

  it('keeps the page overlay paused when playback starts in PiP', () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    const video = createVideo(false);
    player.append(video);
    document.body.append(player);

    const setPaused = vi.fn();
    const controller = new VideoPauseController();
    controller.start({ pauseable: { setPaused }, isDisposed: () => false });

    setPictureInPictureVideo(video);
    video.dispatchEvent(new Event('enterpictureinpicture'));
    expect(setPaused).toHaveBeenLastCalledWith(true);
    setPaused.mockClear();
    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('playing'));

    expect(setPaused).not.toHaveBeenCalledWith(false);

    setPictureInPictureVideo(null);
    video.dispatchEvent(new Event('leavepictureinpicture'));
    expect(setPaused).toHaveBeenLastCalledWith(false);
    controller.stop();
  });

  it('keeps an already-playing PiP video paused when the controller first binds', () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    const video = createVideo(false);
    player.append(video);
    document.body.append(player);
    setPictureInPictureVideo(video);

    const setPaused = vi.fn();
    const controller = new VideoPauseController();
    controller.start({ pauseable: { setPaused }, isDisposed: () => false });

    expect(setPaused).toHaveBeenCalledWith(true);
    expect(setPaused).not.toHaveBeenCalledWith(false);
    controller.stop();
  });

  it('preserves a user pause when leaving PiP', () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    const video = createVideo(false);
    player.append(video);
    document.body.append(player);

    const setPaused = vi.fn();
    const controller = new VideoPauseController();
    controller.start({ pauseable: { setPaused }, isDisposed: () => false });

    setPictureInPictureVideo(video);
    video.dispatchEvent(new Event('enterpictureinpicture'));
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    video.dispatchEvent(new Event('pause'));
    setPaused.mockClear();
    setPictureInPictureVideo(null);
    video.dispatchEvent(new Event('leavepictureinpicture'));

    expect(setPaused).not.toHaveBeenCalledWith(false);
    controller.stop();
  });

  it('synchronizes an already-paused initial video', () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    player.append(createVideo(true));
    document.body.append(player);

    const setPaused = vi.fn();
    const controller = new VideoPauseController();
    controller.start({
      pauseable: { setPaused },
      isDisposed: () => false,
    });

    expect(setPaused).toHaveBeenCalledWith(true);
    controller.stop();
  });

  it('synchronizes the paused state after SPA video rebinding', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.id = 'movie_player';
    const firstVideo = createVideo(false);
    player.append(firstVideo);
    document.body.append(player);

    const setPaused = vi.fn();
    const controller = new VideoPauseController();
    controller.start({
      pauseable: { setPaused },
      isDisposed: () => false,
    });
    setPaused.mockClear();

    firstVideo.remove();
    player.append(createVideo(true));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);

    expect(setPaused).toHaveBeenCalledWith(true);
    controller.stop();
  });

  it('synchronizes the playing state after replacing a paused video', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.id = 'movie_player';
    const firstVideo = createVideo(true);
    player.append(firstVideo);
    document.body.append(player);

    const setPaused = vi.fn();
    const controller = new VideoPauseController();
    controller.start({
      pauseable: { setPaused },
      isDisposed: () => false,
    });
    setPaused.mockClear();

    firstVideo.remove();
    player.append(createVideo(false));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);

    expect(setPaused).toHaveBeenCalledWith(false);
    controller.stop();
  });
});
