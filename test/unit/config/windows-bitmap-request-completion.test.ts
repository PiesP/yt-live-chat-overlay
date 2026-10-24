// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';

import { isCompletedRoutedBitmapFailure } from '../../../validation/windows/bitmap-lifecycle.ts';

type Evidence = Parameters<typeof isCompletedRoutedBitmapFailure>[0];

// Redacted from the installed Edge failure receipt: CDP reported ERR_ABORTED
// after the routed HTTP 200 body reached EOF and decoded into a cached bitmap.
function completedBitmapEvidence(): Evidence {
  const url = 'https://yt3.ggpht.com/windows-bitmap-issue306-sample-recovery.png';
  const failure = { id: 24, url, errorText: 'net::ERR_ABORTED' };
  return {
    failure,
    failures: [failure],
    observations: [
      {
        id: 24,
        url,
        method: 'GET',
        resourceType: 'fetch',
        redirectedFrom: null,
        startedAt: 101,
        responseStatus: 200,
        terminal: 'failed',
        terminalAt: 105,
        errorText: 'net::ERR_ABORTED',
      },
    ],
    routes: [{ url, kind: 'png', status: 200 }],
    completions: [
      { url, kind: 'png', startedAt: 102, settledAt: 103, outcome: 'fulfilled', error: null },
    ],
    probes: [
      {
        id: 'sample-recovery',
        url,
        result: {
          phase: 'acquire',
          id: 'sample-recovery',
          target: 'emoji',
          owned: true,
          width: 4,
          height: 4,
          pixel: [255, 0, 0, 255],
          drawError: null,
          fetchAttempts: 1,
          responseStatus: 200,
          finalUrl: url,
          fetchErrorType: null,
          decodeAttempts: 1,
          decodeSuccesses: 1,
          decodeFailures: 0,
          failedCached: false,
          fetchEventOverflow: 0,
          fetchEvents: [
            { event: 'fetch-start', at: 100 },
            { event: 'signal-state', at: 100, detail: 'active' },
            { event: 'fetch-response', at: 103, detail: '200' },
            { event: 'body-reader', at: 103 },
            { event: 'body-read-done', at: 104 },
            { event: 'decode-start', at: 104 },
            { event: 'decode-success', at: 105 },
          ],
        },
      },
    ],
    noOverflow: true,
  };
}

describe('completed routed bitmap request classification', () => {
  it('accepts the recorded completed request despite its CDP terminal abort', () => {
    expect(isCompletedRoutedBitmapFailure(completedBitmapEvidence())).toBe(true);
  });

  const counterexamples: Array<[string, (evidence: Evidence) => void]> = [
    [
      'missing body EOF',
      (evidence) => {
        evidence.probes[0]?.result.fetchEvents?.splice(4, 1);
      },
    ],
    [
      'aborted signal',
      (evidence) => {
        evidence.probes[0]?.result.fetchEvents?.push({ event: 'signal-abort', at: 105 });
      },
    ],
    [
      'body read error',
      (evidence) => {
        const events = evidence.probes[0]?.result.fetchEvents;
        if (events) events[4] = { event: 'body-read-error', at: 104, detail: 'AbortError' };
      },
    ],
    [
      'body cancellation',
      (evidence) => {
        evidence.probes[0]?.result.fetchEvents?.push({ event: 'body-cancel', at: 105 });
      },
    ],
    [
      'duplicate observed request',
      (evidence) => {
        const observation = evidence.observations[0];
        if (observation) evidence.observations.push({ ...observation, id: 25 });
      },
    ],
    [
      'unknown request identity',
      (evidence) => {
        evidence.failure.id = 25;
      },
    ],
    [
      'non-PNG route',
      (evidence) => {
        const route = evidence.routes[0];
        if (route) route.kind = 'html';
      },
    ],
    [
      'unfulfilled route',
      (evidence) => {
        const completion = evidence.completions[0];
        if (completion) completion.outcome = 'rejected';
      },
    ],
    [
      'decode failure',
      (evidence) => {
        const probe = evidence.probes[0];
        if (probe) probe.result.decodeSuccesses = 0;
      },
    ],
    [
      'wrong drawn pixel',
      (evidence) => {
        const probe = evidence.probes[0];
        if (probe) probe.result.pixel = [0, 0, 0, 255];
      },
    ],
    [
      'different probe identity',
      (evidence) => {
        const probe = evidence.probes[0];
        if (probe) probe.id = 'other-recovery';
      },
    ],
    [
      'overflowed evidence',
      (evidence) => {
        evidence.noOverflow = false;
      },
    ],
    [
      'overflowed Worker events',
      (evidence) => {
        const probe = evidence.probes[0];
        if (probe) probe.result.fetchEventOverflow = 1;
      },
    ],
  ];
  it.each(counterexamples)('rejects %s', (_, change) => {
    const evidence = completedBitmapEvidence();
    change(evidence);
    expect(isCompletedRoutedBitmapFailure(evidence)).toBe(false);
  });
});
