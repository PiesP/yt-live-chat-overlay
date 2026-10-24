// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNativeCtrlSpace,
  imeWordBehavior,
  type ImeCheckpoint,
} from './viewing-experience.ts';

function checkpoint(overrides: Partial<ImeCheckpoint> = {}): ImeCheckpoint {
  return {
    title: 'YT Viewing IME Checkpoint',
    focus: 'yt-viewing-ime-input',
    input: '',
    events: [],
    videoPaused: false,
    videoTime: 2,
    overlayPaused: false,
    ...overrides,
  };
}

test('Hangul proof requires the actual word and all trusted composition phases', () => {
  const events = ['compositionstart', 'compositionupdate', 'compositionend'].map((type) => ({
    type,
    trusted: true,
  }));
  assert.equal(imeWordBehavior(checkpoint({ input: '한글 ', events })), 'hangul');
  assert.equal(imeWordBehavior(checkpoint({ input: '한글 ', events: events.slice(1) })), 'unknown');
  assert.equal(
    imeWordBehavior(
      checkpoint({ input: '한글 ', events: events.map((event) => ({ ...event, trusted: false })) })
    ),
    'unknown'
  );
  assert.equal(imeWordBehavior(checkpoint({ input: 'gksrmf ' })), 'latin');
  assert.equal(imeWordBehavior(checkpoint({ input: 'gksrmf ', events })), 'unknown');
});

test('native shortcut evidence checks both overlay and video states', () => {
  const events = [
    { type: 'document-keydown', focus: 'yt-viewing-ime-input', trusted: true },
    {
      type: 'post-ctrl-space',
      focus: 'yt-viewing-ime-input',
      overlayPaused: false,
      videoPaused: false,
      videoTime: 2.1,
    },
    { type: 'document-keydown', focus: 'yt-viewing-ime-input', trusted: true },
    {
      type: 'post-ctrl-space',
      focus: 'yt-viewing-ime-input',
      overlayPaused: false,
      videoPaused: false,
      videoTime: 2.7,
    },
  ];
  assertNativeCtrlSpace(checkpoint({ events }), 'yt-viewing-ime-input', [false, false]);
  const pausedVideo = events.map((event, index) =>
    index === 1 ? { ...event, videoPaused: true } : event
  );
  assert.throws(
    () =>
      assertNativeCtrlSpace(checkpoint({ events: pausedVideo }), 'yt-viewing-ime-input', [
        false,
        false,
      ]),
    /Expected values to be strictly deep-equal/u
  );
  assert.throws(
    () => assertNativeCtrlSpace(checkpoint({ events }), 'movie_player', [true, false]),
    /expected focus/u
  );
});
