// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  assessLiveContentPrerequisite,
  runLiveContentPrerequisite,
} from '../../../validation/windows/live-content-prerequisite.ts';
import type { LiveContentSample } from '../../../validation/windows/live-content-prerequisite.ts';

const VIDEO_ID = 'exampleVideoId';
const SOURCE_SHA = 'a'.repeat(64);

function contentSample(overrides: Partial<LiveContentSample> = {}): LiveContentSample {
  return {
    elapsedMs: 1000,
    routeMatched: true,
    pageBarrier: null,
    responseVideoId: VIDEO_ID,
    playerVideoId: VIDEO_ID,
    playabilityStatus: 'OK',
    adShowing: false,
    playerErrorVisible: false,
    videoOwned: true,
    sameVideoAsPrevious: true,
    sourceSha256: SOURCE_SHA,
    sourceChangedFromPrevious: false,
    readyState: 4,
    networkState: 2,
    errorCode: null,
    paused: false,
    muted: true,
    currentTime: 10,
    totalVideoFrames: 240,
    videoWidth: 1920,
    videoHeight: 1080,
    seekable: { start: 0, end: 20 },
    ...overrides,
  };
}

describe('public content prerequisite assessment', () => {
  it('requires progress on the same owned element and source with both public identities', () => {
    const first = contentSample({ sameVideoAsPrevious: null });
    const second = contentSample({ elapsedMs: 1750, currentTime: 10.75, totalVideoFrames: 258 });

    expect(assessLiveContentPrerequisite([first, second], VIDEO_ID)).toEqual({
      status: 'passed',
      reason: 'public-player-associated-identity-playback-and-seekable-range-observed',
      qualifyingPair: [0, 1],
      adTransition: 'not-observed',
      adSampleIndex: null,
    });
  });

  it('marks a site ad-state transition only after an ad sample precedes qualifying player playback', () => {
    const ad = contentSample({ adShowing: true, currentTime: 1, totalVideoFrames: 20 });
    const first = contentSample({ elapsedMs: 1750, currentTime: 10, totalVideoFrames: 240 });
    const second = contentSample({ elapsedMs: 2500, currentTime: 10.75, totalVideoFrames: 258 });

    expect(assessLiveContentPrerequisite([ad, first, second], VIDEO_ID)).toMatchObject({
      status: 'passed',
      qualifyingPair: [1, 2],
      adTransition: 'observed',
      adSampleIndex: 0,
    });
  });

  it('accepts progressing requested content when a replacement player unmutes itself', () => {
    const first = contentSample({
      elapsedMs: 5695,
      currentTime: 46793.528193,
      totalVideoFrames: 107,
      seekable: { start: 0, end: 50390.106562 },
      sameVideoAsPrevious: null,
      muted: false,
    });
    const second = contentSample({
      elapsedMs: 6521,
      currentTime: 46794.282075,
      totalVideoFrames: 130,
      seekable: first.seekable,
      muted: false,
    });

    expect(assessLiveContentPrerequisite([first, second], VIDEO_ID)).toMatchObject({
      status: 'passed',
      qualifyingPair: [0, 1],
      adTransition: 'not-observed',
    });
  });

  it('records an observed ad without claiming that it ended when content never qualifies', () => {
    const ad = contentSample({ adShowing: true, currentTime: 1, totalVideoFrames: 20 });
    const stalled = contentSample({
      elapsedMs: 1750,
      currentTime: 1,
      totalVideoFrames: 20,
      adShowing: true,
    });

    expect(assessLiveContentPrerequisite([ad, stalled], VIDEO_ID)).toMatchObject({
      status: 'unverified',
      adTransition: 'not-observed',
      adSampleIndex: 0,
    });
  });

  it.each([
    ['provider identity', { responseVideoId: null }],
    ['player identity', { playerVideoId: 'different' }],
    ['playability', { playabilityStatus: null }],
    ['ad state', { adShowing: true }],
    ['owned element', { sameVideoAsPrevious: false }],
    ['same source', { sourceChangedFromPrevious: true }],
    ['time progress', { currentTime: 10 }],
    ['frame progress', { totalVideoFrames: 240 }],
    ['seekable range', { seekable: { start: 19, end: 20 } }],
    ['current time above seekable range', { currentTime: 50 }],
    ['non-finite current time', { currentTime: Number.NaN }],
    ['media error', { errorCode: 3 }],
    ['consent barrier', { routeMatched: false, pageBarrier: 'consent' as const }],
    ['login barrier', { routeMatched: false, pageBarrier: 'login' as const }],
  ])('does not qualify %s without its required evidence', (_label, broken) => {
    const first = contentSample({ sameVideoAsPrevious: null });
    const second = contentSample({
      elapsedMs: 1750,
      currentTime: 10.75,
      totalVideoFrames: 258,
      ...broken,
    });

    expect(assessLiveContentPrerequisite([first, second], VIDEO_ID).status).toBe('unverified');
  });

  it.each([
    ['below', -3, -2.25],
    ['above', 25, 25.75],
  ])(
    'rejects progressing time and frames %s the seekable range',
    (_label, firstTime, secondTime) => {
      const first = contentSample({ sameVideoAsPrevious: null, currentTime: firstTime });
      const second = contentSample({
        elapsedMs: 1750,
        currentTime: secondTime,
        totalVideoFrames: 258,
      });

      expect(assessLiveContentPrerequisite([first, second], VIDEO_ID).status).toBe('unverified');
    }
  );

  it('leaves late page creation uncertain while attaching a bounded close guard', async () => {
    const output = await mkdtemp(join(tmpdir(), 'yt-public-prerequisite-'));
    let resolveCreation: (page: Page) => void = () => {};
    const creation = new Promise<Page>((resolve) => {
      resolveCreation = resolve;
    });
    const context = { newPage: () => creation } as unknown as BrowserContext;
    const latePage = { close: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
    try {
      const result = await runLiveContentPrerequisite({
        context,
        url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
        output,
        index: 1,
      });
      expect(result.status).toBe('unverified');
      expect(result.failureStage).toBe('create-page');
      expect(result.failureType).toBe('BoundaryTimeoutError');
      expect(result.cleanup).toMatchObject({
        pageClosed: false,
        pageCreationTimedOut: true,
        latePageCloseGuardAttached: true,
        callerContextCleanupRequired: true,
      });
      const receipt = JSON.parse(
        await readFile(join(output, 'live-content-prerequisite-1.json'), 'utf8')
      ) as { status: string; cleanup: { pageClosed: boolean } };
      expect(receipt.status).toBe('unverified');
      expect(receipt.cleanup.pageClosed).toBe(false);
      resolveCreation(latePage);
      await vi.waitFor(() => expect(latePage.close).toHaveBeenCalledOnce());
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 12_000);

  it('bounds page cleanup and retains the primary navigation failure in the receipt', async () => {
    const output = await mkdtemp(join(tmpdir(), 'yt-public-prerequisite-'));
    let resolveClose: () => void = () => {};
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const page = {
      goto: vi.fn().mockRejectedValue(new Error('navigation blocked')),
      close: vi.fn(() => close),
    } as unknown as Page;
    const context = { newPage: vi.fn().mockResolvedValue(page) } as unknown as BrowserContext;
    try {
      const result = await runLiveContentPrerequisite({
        context,
        url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
        output,
        index: 2,
      });
      expect(result.status).toBe('unverified');
      expect(result.failureStage).toBe('navigate');
      expect(result.failureType).toBe('Error');
      expect(result.statusReason).toBe('observation-navigate-unverified');
      expect(result.cleanup).toMatchObject({
        pageClosed: false,
        pageCloseTimedOut: true,
        callerContextCleanupRequired: true,
      });
      const receipt = JSON.parse(
        await readFile(join(output, 'live-content-prerequisite-2.json'), 'utf8')
      ) as { failureStage: string; cleanup: { pageCloseTimedOut: boolean } };
      expect(receipt.failureStage).toBe('navigate');
      expect(receipt.cleanup.pageCloseTimedOut).toBe(true);
    } finally {
      resolveClose();
      await rm(output, { recursive: true, force: true });
    }
  }, 12_000);
});
