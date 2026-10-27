// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserContext } from '@playwright/test';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  readPublicDurationPageState,
  runLiveDuration,
} from '../../../validation/windows/live-duration.ts';

describe('public duration ownership failure receipt', () => {
  it('records lost video ownership and disposes both fixed handles before any control action', async () => {
    const disposeVideo = vi.fn().mockResolvedValue(undefined);
    const disposePlayer = vi.fn().mockResolvedValue(undefined);
    const closePage = vi.fn().mockResolvedValue(undefined);
    const closeBackground = vi.fn().mockResolvedValue(undefined);
    const video = { evaluate: vi.fn(), dispose: disposeVideo };
    const player = { hover: vi.fn(), dispose: disposePlayer };
    const page = {
      on: vi.fn(),
      bringToFront: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      getByRole: vi.fn(() => ({ isVisible: vi.fn().mockResolvedValue(false) })),
      locator: vi.fn((selector: string) =>
        selector === '#movie_player'
          ? {
              waitFor: vi.fn().mockResolvedValue(undefined),
              elementHandle: vi.fn().mockResolvedValue(player),
            }
          : { elementHandle: vi.fn().mockResolvedValue(video) }
      ),
      evaluate: vi.fn(async (fn: unknown) => {
        if (fn === readPublicDurationPageState) {
          throw new Error('Owned public player video is absent, ambiguous, or replaced');
        }
        return {
          playerFound: true,
          playerAmbiguous: false,
          providerStatusSource: 'ytInitialPlayerResponse-initial',
          mediaIdentity: 'unavailable',
          providerStatus: null,
          providerReason: null,
          mediaNetworkState: null,
          mediaErrorCode: null,
          candidates: [],
        };
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
        runLiveDuration({
          context,
          url: 'https://www.youtube.com/watch?v=public',
          output,
        })
      ).rejects.toThrow(
        'Duration observation failed during preflight:wait-native-mute-precondition'
      );
      const result = JSON.parse(await readFile(join(output, 'live-duration-result.json'), 'utf8'));
      expect(result).toMatchObject({
        status: 'failed',
        evidenceStatus: 'unverified',
        failureState: null,
        failurePlayerDom: { mediaIdentity: 'unavailable', mediaNetworkState: null },
        failures: [
          { stage: 'preflight:wait-native-mute-precondition', reason: 'owned-public-video-lost' },
        ],
      });
      expect(disposeVideo).toHaveBeenCalledOnce();
      expect(disposePlayer).toHaveBeenCalledOnce();
      expect(closePage).toHaveBeenCalledOnce();
      expect(closeBackground).toHaveBeenCalledOnce();
      expect(video.evaluate).not.toHaveBeenCalled();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
