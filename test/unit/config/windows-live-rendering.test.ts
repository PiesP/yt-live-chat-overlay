// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vite-plus/test';

import { selectPublicSeekTarget } from '../../../validation/windows/live-rendering.ts';

describe('shared public-media seek calculation', () => {
  it.each([
    { name: 'forward motion', range: { currentTime: 10, start: 0, end: 100 }, expected: 13 },
    {
      name: 'near-end backward fallback',
      range: { currentTime: 99, start: 0, end: 100 },
      expected: 96,
    },
    {
      name: 'backward preference',
      range: { currentTime: 97, start: 0, end: 100 },
      preferBackward: true,
      expected: 94,
    },
    { name: 'near-end forward', range: { currentTime: 97, start: 0, end: 100 }, expected: 99 },
    {
      name: 'backward preference at start falls forward',
      range: { currentTime: 1.5, start: 0, end: 100 },
      preferBackward: true,
      expected: 4.5,
    },
    { name: 'short window', range: { currentTime: 10, start: 8, end: 11 }, expected: null },
    {
      name: 'non-finite current time',
      range: { currentTime: NaN, start: 0, end: 100 },
      expected: null,
    },
    {
      name: 'non-finite boundary',
      range: { currentTime: 10, start: 0, end: Infinity },
      expected: null,
    },
    { name: 'no valid target', range: { currentTime: 30, start: 30, end: 32 }, expected: null },
  ])('handles $name', ({ range, preferBackward, expected }) => {
    expect(
      selectPublicSeekTarget(range, preferBackward === undefined ? {} : { preferBackward })
    ).toBe(expected);
  });
});
