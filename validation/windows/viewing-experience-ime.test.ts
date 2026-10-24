// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNativeCtrlSpace,
  assertNativeEditableCtrlSpace,
  imeWordBehavior,
  type ImeCheckpoint,
  type NativeControlSample,
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

test('Hangul proof accepts observed end with trusted native start, update, key and input', () => {
  const events = [
    { type: 'keydown', key: 'Process', trusted: true, isComposing: false },
    { type: 'compositionstart', trusted: true, data: '' },
    { type: 'compositionupdate', trusted: true, data: '한' },
    { type: 'keydown', key: 'Process', trusted: true, isComposing: true },
    { type: 'input', trusted: true },
    { type: 'compositionend', trusted: false, data: '한' },
    { type: 'keydown', key: ' ', trusted: true, isComposing: false },
    { type: 'input', trusted: true },
  ];
  const committed = { input: '한글 ', settledInput: '한글 ', settledFocus: 'yt-viewing-ime-input' };
  assert.equal(imeWordBehavior(checkpoint({ ...committed, events })), 'hangul');
  assert.equal(imeWordBehavior(checkpoint({ ...committed, events: events.slice(2) })), 'unknown');
  assert.equal(
    imeWordBehavior(
      checkpoint({
        ...committed,
        events: events.map((event) => ({ ...event, trusted: false })),
      })
    ),
    'unknown'
  );
  assert.equal(
    imeWordBehavior(
      checkpoint({
        ...committed,
        events: events.filter((event) => event.type !== 'compositionend'),
      })
    ),
    'unknown'
  );
  assert.equal(imeWordBehavior(checkpoint({ input: '한글 ', events })), 'unknown');
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

test('editable IME may consume native Ctrl+Space before the document shortcut', () => {
  const samples: NativeControlSample[] = Array.from({ length: 12 }, (_, index) => ({
    atMs: index * 75,
    focus: 'yt-viewing-ime-input',
    input: '한글 ',
    overlayPaused: false,
    videoPaused: false,
    videoTime: 2 + index * 0.075,
  }));
  const state = checkpoint({
    input: '한글 ',
    events: [
      { type: 'keydown', key: 'Control', trusted: true },
      { type: 'keydown', key: 'HanjaMode', trusted: true },
      { type: 'keydown', key: 'Control', trusted: true },
      { type: 'keydown', key: 'HanjaMode', trusted: true },
    ],
  });
  assert.equal(
    assertNativeEditableCtrlSpace(state, samples, '한글 '),
    'ime-consumed-before-document'
  );
  assert.throws(
    () =>
      assertNativeEditableCtrlSpace(
        state,
        samples.map((sample) => ({ ...sample, videoPaused: true })),
        '한글 '
      ),
    /Focused input, overlay, or video changed/u
  );
  assert.throws(
    () => assertNativeEditableCtrlSpace({ ...state, input: '한글 x' }, samples, '한글 '),
    /changed the composed input/u
  );
  assert.throws(
    () => assertNativeCtrlSpace(state, 'movie_player', [true, false]),
    /Expected two native Ctrl\+Space keydown events/u
  );
});
