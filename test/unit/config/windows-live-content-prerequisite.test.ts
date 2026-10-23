// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vite-plus/test';

import { assessLiveContentPrerequisite } from '../../../validation/windows/live-content-prerequisite.ts';
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
      reason: 'public-content-identity-playback-and-seekable-range-observed',
      qualifyingPair: [0, 1],
      adTransition: 'not-observed',
      adSampleIndex: null,
    });
  });

  it('credits an ad transition only after a real ad sample precedes qualifying content', () => {
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
});
