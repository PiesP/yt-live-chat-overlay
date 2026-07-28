// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoPauseController } from '@app/video-pause-controller';

function createVideo(paused: boolean): HTMLVideoElement {
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  Object.defineProperty(video, 'paused', {
    configurable: true,
    value: paused,
  });
  return video;
}

describe('VideoPauseController', () => {
  afterEach(() => {
    vi.useRealTimers();
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
