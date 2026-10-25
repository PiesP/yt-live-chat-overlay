// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertNativeCtrlSpace,
  assertNativeEditableCtrlSpace,
  assertNativePlayerCtrlSpace,
  imeWordBehavior,
  japaneseWordBehavior,
  assertJapaneseToggleProbeAllowed,
  canonicalSettingsForPauseComparison,
  japaneseModeRestored,
  japaneseNativeBehaviorVerdict,
  japaneseCapsLockComparison,
  japaneseIncompleteVerdicts,
  japaneseCompositionOpen,
  assertInterruptedJapaneseComposition,
  japaneseDirectGateObserved,
  assertJapaneseDirectShortcut,
  directControlGateToken,
  assertJapanesePlayerSpace,
  assertJapaneseShortcut,
  type ImeCheckpoint,
  type NativeControlSample,
} from './viewing-experience.ts';

function checkpoint(overrides: Partial<ImeCheckpoint> = {}): ImeCheckpoint {
  return {
    title: 'YT Viewing IME Checkpoint',
    focus: 'yt-viewing-ime-input',
    input: '',
    events: [],
    traceOverflow: false,
    videoPaused: false,
    videoTime: 2,
    overlayPaused: false,
    ...overrides,
  };
}

// Projected from retained Japanese Enter 08 native browser trace; event order and gate offset are exact.
type Actual08TraceRow = readonly [
  string,
  boolean,
  string | null,
  string | null,
  string | null,
  boolean | null,
];
const actual08CompositionRows: Actual08TraceRow[] = [
  ['keydown', true, null, null, 'Control', false],
  ['keydown', true, null, null, 'Process', false],
  ['compositionstart', true, '', null, null, null],
  ['compositionupdate', true, 'ｎ', null, null, null],
  ['beforeinput', true, 'ｎ', 'insertCompositionText', null, null],
  ['input', true, 'ｎ', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, 'に', null, null, null],
  ['beforeinput', true, 'に', 'insertCompositionText', null, null],
  ['input', true, 'に', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, 'にｈ', null, null, null],
  ['beforeinput', true, 'にｈ', 'insertCompositionText', null, null],
  ['input', true, 'にｈ', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, 'にほ', null, null, null],
  ['beforeinput', true, 'にほ', 'insertCompositionText', null, null],
  ['input', true, 'にほ', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, 'にほｎ', null, null, null],
  ['beforeinput', true, 'にほｎ', 'insertCompositionText', null, null],
  ['input', true, 'にほｎ', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['keydown', true, null, null, 'Control', true],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, 'にほｎ ', null, null, null],
  ['beforeinput', true, 'にほｎ ', 'insertCompositionText', null, null],
  ['input', true, 'にほｎ ', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, 'にほｎ ｇ', null, null, null],
  ['beforeinput', true, 'にほｎ ｇ', 'insertCompositionText', null, null],
  ['input', true, 'にほｎ ｇ', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, 'にほｎ ご', null, null, null],
  ['beforeinput', true, 'にほｎ ご', 'insertCompositionText', null, null],
  ['input', true, 'にほｎ ご', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, '丹保n 語', null, null, null],
  ['beforeinput', true, '丹保n 語', 'insertCompositionText', null, null],
  ['input', true, '丹保n 語', 'insertCompositionText', null, null],
  ['keydown', true, null, null, 'Process', true],
  ['compositionupdate', true, '丹保n 語', null, null, null],
  ['beforeinput', true, '丹保n 語', 'insertCompositionText', null, null],
  ['input', true, '丹保n 語', 'insertCompositionText', null, null],
  ['compositionend', false, '丹保n 語', null, null, null],
];
const actual08DirectRows: Actual08TraceRow[] = [
  ['keydown', true, null, null, 'Shift', false],
  ['keydown', true, null, null, 'n', false],
  ['beforeinput', true, 'n', 'insertText', null, null],
  ['input', true, 'n', 'insertText', null, null],
  ['keydown', true, null, null, 'i', false],
  ['beforeinput', true, 'i', 'insertText', null, null],
  ['input', true, 'i', 'insertText', null, null],
  ['keydown', true, null, null, 'h', false],
  ['beforeinput', true, 'h', 'insertText', null, null],
  ['input', true, 'h', 'insertText', null, null],
  ['keydown', true, null, null, 'o', false],
  ['beforeinput', true, 'o', 'insertText', null, null],
  ['input', true, 'o', 'insertText', null, null],
  ['keydown', true, null, null, 'n', false],
  ['beforeinput', true, 'n', 'insertText', null, null],
  ['input', true, 'n', 'insertText', null, null],
  ['keydown', true, null, null, 'g', false],
  ['beforeinput', true, 'g', 'insertText', null, null],
  ['input', true, 'g', 'insertText', null, null],
  ['keydown', true, null, null, 'o', false],
  ['beforeinput', true, 'o', 'insertText', null, null],
  ['input', true, 'o', 'insertText', null, null],
  ['keydown', true, null, null, 'Enter', false],
  ['beforeinput', true, null, 'insertParagraph', null, null],
  ['input', true, null, 'insertParagraph', null, null],
];
function actual08Events(rows: Actual08TraceRow[], target: string): ImeCheckpoint['events'] {
  return rows.map(([type, trusted, data, inputType, key, isComposing]) => ({
    type,
    target,
    trusted,
    data,
    inputType,
    key,
    isComposing,
  }));
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

test('Japanese evidence requires committed converted text and trusted composition in the selected target', () => {
  const target = 'yt-viewing-ime-editable';
  const events = [
    { type: 'compositionstart', target, trusted: true },
    { type: 'compositionupdate', target, trusted: true, data: 'にほんご' },
    { type: 'compositionupdate', target, trusted: true, data: '日本語' },
    { type: 'compositionend', target, trusted: false, data: '日本語' },
    { type: 'input', target, trusted: true, data: '日本語' },
  ];
  const converted = checkpoint({
    focus: target,
    editable: '日本語',
    settledEditable: '日本語',
    settledFocus: target,
    events,
  });
  assert.equal(japaneseWordBehavior(converted, 'editable'), 'converted-japanese');
  assert.equal(
    japaneseWordBehavior({ ...converted, editable: '漢', settledEditable: '漢' }, 'editable'),
    'unknown'
  );
  assert.equal(japaneseWordBehavior({ ...converted, traceOverflow: true }, 'editable'), 'unknown');
  assert.equal(
    japaneseWordBehavior({ ...converted, events: events.slice(1) }, 'editable'),
    'unknown'
  );
  assert.equal(
    japaneseWordBehavior(
      { ...converted, events: events.map((event) => ({ ...event, trusted: false })) },
      'editable'
    ),
    'unknown'
  );
  assert.equal(japaneseWordBehavior({ ...converted, editable: 'にほんご' }, 'editable'), 'unknown');
  assert.equal(
    japaneseWordBehavior({ ...converted, settledEditable: 'altered' }, 'editable'),
    'unknown'
  );
  assert.equal(
    japaneseWordBehavior({ ...converted, input: '日本語', settledInput: '日本語' }, 'textarea'),
    'unknown'
  );

  const direct = checkpoint({
    input: 'nihongo',
    settledInput: 'nihongo',
    settledFocus: 'yt-viewing-ime-input',
    events: [{ type: 'input', target: 'yt-viewing-ime-input', trusted: true }],
  });
  assert.equal(japaneseWordBehavior(direct, 'textarea'), 'direct-latin');
  assert.doesNotThrow(() => assertJapaneseToggleProbeAllowed(direct, 'textarea'));
  assert.throws(() => assertJapaneseToggleProbeAllowed(converted, 'editable'), /observed direct/u);
  assert.throws(
    () => assertJapaneseToggleProbeAllowed({ ...direct, events: [] }, 'textarea'),
    /observed direct/u
  );
  assert.equal(japaneseWordBehavior({ ...direct, events: [] }, 'textarea'), 'unknown');
});

test('Japanese textarea proof admits one native Enter line break after committed composition', () => {
  const target = 'yt-viewing-ime-input';
  const events: ImeCheckpoint['events'] = [
    { type: 'compositionstart', target, trusted: true },
    { type: 'compositionupdate', target, trusted: true, data: '日本語' },
    { type: 'input', target, trusted: true, data: '日本語' },
    { type: 'compositionend', target, trusted: false, data: '日本語' },
    { type: 'keydown', target, trusted: true, key: 'Enter', isComposing: false },
    { type: 'beforeinput', target, trusted: true, inputType: 'insertLineBreak' },
    { type: 'input', target, trusted: true, inputType: 'insertLineBreak' },
  ];
  const converted = checkpoint({
    input: '日本語\n',
    settledInput: '日本語\n',
    settledFocus: target,
    events,
  });
  assert.equal(japaneseWordBehavior(converted, 'textarea'), 'converted-japanese');
  for (const changed of [
    events.filter((event) => event.type !== 'keydown'),
    events.filter((event) => event.type !== 'beforeinput'),
    events.filter((event) => event.inputType !== 'insertLineBreak'),
    events.map((event) => (event.type === 'keydown' ? { ...event, trusted: false } : event)),
    events.map((event) =>
      event.inputType === 'insertLineBreak' ? { ...event, trusted: false } : event
    ),
    events.map((event) => (event.type === 'keydown' ? { ...event, isComposing: true } : event)),
    events.slice(0, 4).concat(events.slice(5), events.slice(4, 5)),
  ]) {
    assert.equal(japaneseWordBehavior({ ...converted, events: changed }, 'textarea'), 'unknown');
  }
  for (const text of ['\n日本語', ' 日本語', '日本語\n\n', '日本語x', '日本語 \n']) {
    assert.equal(
      japaneseWordBehavior({ ...converted, input: text, settledInput: text }, 'textarea'),
      'unknown'
    );
  }
  assert.equal(
    japaneseWordBehavior({ ...converted, settledInput: '日本語' }, 'textarea'),
    'unknown'
  );
  assert.equal(
    japaneseWordBehavior(
      checkpoint({
        focus: 'yt-viewing-ime-editable',
        editable: '日本語\n',
        settledEditable: '日本語\n',
        settledFocus: 'yt-viewing-ime-editable',
        events: events.map((event) => ({ ...event, target: 'yt-viewing-ime-editable' })),
      }),
      'editable'
    ),
    'unknown'
  );
});

test('pause settings comparison only ignores valid hex color letter case', () => {
  const before = JSON.stringify({
    enabled: true,
    language: 'en',
    colors: { normal: '#FFFFFF', member: '#0F9D58' },
    backgroundColors: { member: '#1B3A6F59' },
  });
  const sameColors = JSON.stringify({
    enabled: true,
    language: 'en',
    colors: { normal: '#ffffff', member: '#0f9d58' },
    backgroundColors: { member: '#1b3a6f59' },
  });
  assert.deepEqual(
    canonicalSettingsForPauseComparison(before),
    canonicalSettingsForPauseComparison(sameColors)
  );
  const changedValue = sameColors.replace('#ffffff', '#fffffe');
  assert.notDeepEqual(
    canonicalSettingsForPauseComparison(before),
    canonicalSettingsForPauseComparison(changedValue)
  );
  const changedSetting = sameColors.replace('"language":"en"', '"language":"ja"');
  assert.notDeepEqual(
    canonicalSettingsForPauseComparison(before),
    canonicalSettingsForPauseComparison(changedSetting)
  );
  assert.notDeepEqual(
    canonicalSettingsForPauseComparison('{"colors":{"normal":"NotHex"}}'),
    canonicalSettingsForPauseComparison('{"colors":{"normal":"nothex"}}')
  );
});

test('Japanese native behavior needs a converted word after Pause independently of mode restoration', () => {
  const restoredDirectMode = japaneseModeRestored('direct-latin', {
    sequence: 'JapaneseCurrent',
    behavior: 'direct-latin',
  });
  assert.equal(
    japaneseNativeBehaviorVerdict('direct-latin', restoredDirectMode, 'same').status,
    'Fail'
  );
  assert.equal(japaneseNativeBehaviorVerdict('unknown', restoredDirectMode, 'same').status, 'Fail');
  assert.equal(
    japaneseNativeBehaviorVerdict('converted-japanese', restoredDirectMode, 'same').status,
    'Pass'
  );
  assert.equal(japaneseNativeBehaviorVerdict('converted-japanese', false, 'same').status, 'Fail');
  assert.equal(japaneseNativeBehaviorVerdict('converted-japanese', true, 'changed').status, 'Fail');
  assert.equal(
    japaneseNativeBehaviorVerdict('converted-japanese', true, 'unverified').status,
    'Not run'
  );
});

test('Japanese native shortcut validates focus, preserved text, and player progress', () => {
  const samples: NativeControlSample[] = Array.from({ length: 16 }, (_, index) => ({
    atMs: index * 75,
    focus: 'yt-viewing-ime-editable',
    input: '',
    editable: '日本語',
    overlayPaused: false,
    videoPaused: false,
    videoTime: 2 + index * 0.075,
  }));
  const state = checkpoint({ focus: 'yt-viewing-ime-editable', editable: '日本語' });
  assert.equal(
    assertJapaneseShortcut(state, samples, 'yt-viewing-ime-editable', '日本語'),
    'not-delivered-to-document'
  );
  assert.throws(
    () =>
      assertJapaneseShortcut(
        state,
        samples.map((sample) => ({ ...sample, videoTime: 2 })),
        'yt-viewing-ime-editable',
        '日本語'
      ),
    /Video did not advance/u
  );
  assert.throws(
    () =>
      assertJapaneseShortcut(
        state,
        samples.map((sample) => ({ ...sample, editable: 'changed' })),
        'yt-viewing-ime-editable',
        '日本語'
      ),
    /Focused text/u
  );
  const delivered = checkpoint({
    focus: 'movie_player',
    input: '',
    events: [
      { type: 'document-keydown', trusted: true, focus: 'movie_player' },
      { type: 'post-ctrl-space', focus: 'movie_player', overlayPaused: true, videoPaused: false },
      { type: 'document-keydown', trusted: true, focus: 'movie_player' },
      { type: 'post-ctrl-space', focus: 'movie_player', overlayPaused: false, videoPaused: false },
    ],
  });
  const playerSamples = samples.map((sample) => ({ ...sample, focus: 'movie_player', input: '' }));
  assert.equal(assertJapaneseShortcut(delivered, playerSamples, 'movie_player', ''), 'delivered');
  assert.throws(
    () =>
      assertJapaneseShortcut(
        { ...delivered, events: delivered.events.slice(0, 2) },
        playerSamples,
        'movie_player',
        ''
      ),
    /Incomplete/u
  );
});

test('Japanese mode restoration requires a separate unforced input observation', () => {
  assert.equal(
    japaneseModeRestored('converted-japanese', {
      sequence: 'JapaneseHiragana',
      behavior: 'converted-japanese',
    }),
    false
  );
  assert.equal(
    japaneseModeRestored('direct-latin', { sequence: 'JapaneseDirect', behavior: 'direct-latin' }),
    false
  );
  assert.equal(
    japaneseModeRestored('converted-japanese', {
      sequence: 'JapaneseCurrent',
      behavior: 'direct-latin',
    }),
    false
  );
  assert.equal(
    japaneseModeRestored('unknown', { sequence: 'JapaneseCurrent', behavior: 'unknown' }),
    false
  );
  assert.equal(
    japaneseModeRestored('converted-japanese', {
      sequence: 'JapaneseCurrent',
      behavior: 'converted-japanese',
    }),
    true
  );
});

test('Caps Lock restoration compares trusted browser key state and keeps gaps unverified', () => {
  const key = (capsLock: boolean) => ({
    type: 'keydown',
    target: 'yt-viewing-ime-input',
    trusted: true,
    capsLock,
  });
  const initial = checkpoint({ events: [key(false), key(false)] });
  assert.equal(japaneseCapsLockComparison(initial, checkpoint({ events: [key(false)] })), 'same');
  assert.equal(japaneseCapsLockComparison(initial, checkpoint({ events: [key(true)] })), 'changed');
  assert.equal(japaneseCapsLockComparison(initial, checkpoint({ events: [] })), 'unverified');
  assert.equal(
    japaneseCapsLockComparison(initial, checkpoint({ events: [key(false), key(true)] })),
    'unverified'
  );
  assert.equal(
    japaneseCapsLockComparison(initial, checkpoint({ events: [key(false)], traceOverflow: true })),
    'unverified'
  );
  assert.equal(
    japaneseCapsLockComparison(
      checkpoint({ events: [{ ...key(false), trusted: false }] }),
      checkpoint({ events: [key(false)] })
    ),
    'unverified'
  );
});

test('Japanese native verification requires every selected case to pass', () => {
  const passed = Object.fromEntries(
    ['JI-01', 'JI-02', 'JI-03', 'JI-04'].map((id) => [id, { status: 'Pass' as const }])
  );
  assert.deepEqual(japaneseIncompleteVerdicts(passed), []);
  assert.deepEqual(
    japaneseIncompleteVerdicts({
      ...passed,
      'JI-04': { status: 'Not run', reason: 'Caps Lock state unverified' },
    }),
    ['JI-04: Not run (Caps Lock state unverified)']
  );
  assert.deepEqual(japaneseIncompleteVerdicts({ ...passed, 'JI-02': { status: 'Fail' } }), [
    'JI-02: Fail',
  ]);
  assert.deepEqual(japaneseIncompleteVerdicts({ 'JI-01': { status: 'Pass' } }), [
    'JI-02: missing',
    'JI-03: missing',
    'JI-04: missing',
  ]);
});

test('Japanese composing shortcut gate requires an open trusted composition', () => {
  const start = { type: 'compositionstart', target: 'yt-viewing-ime-input', trusted: true };
  const update = { type: 'compositionupdate', target: 'yt-viewing-ime-input', trusted: true };
  const active = checkpoint({ events: [start, update] });
  assert.equal(japaneseCompositionOpen(active), true);
  assert.equal(japaneseCompositionOpen({ ...active, events: [start] }), false);
  assert.equal(
    japaneseCompositionOpen({ ...active, events: [{ ...start, trusted: false }, update] }),
    false
  );
  assert.equal(
    japaneseCompositionOpen({
      ...active,
      events: [start, update, { type: 'compositionend', target: 'yt-viewing-ime-input' }],
    }),
    false
  );
  assert.equal(japaneseCompositionOpen({ ...active, focus: 'movie_player' }), false);
  assert.equal(japaneseCompositionOpen({ ...active, traceOverflow: true }), false);
});

test('actual Enter 08 interrupted composition records native literal space without document delivery', () => {
  const target = 'yt-viewing-ime-input';
  const events = actual08Events(actual08CompositionRows, target);
  const state = checkpoint({
    input: '丹保n 語',
    settledInput: '丹保n 語',
    settledFocus: target,
    events,
  });
  const gate = { open: true, focus: target, eventCount: 22, traceOverflow: false };
  assert.deepEqual(assertInterruptedJapaneseComposition(state, gate), {
    route: 'not-delivered-to-document',
    preGatePrefix: 'にほｎ',
    literalSpace: 'にほｎ ',
    continuedComposition: 'にほｎ ご',
    committedText: '丹保n 語',
  });
  const changed = (index: number, patch: Record<string, unknown>): ImeCheckpoint => ({
    ...state,
    events: events.map((event, position) => (position === index ? { ...event, ...patch } : event)),
  });
  for (const invalid of [
    () => assertInterruptedJapaneseComposition(state, undefined),
    () => assertInterruptedJapaneseComposition(state, { ...gate, open: false }),
    () => assertInterruptedJapaneseComposition(state, { ...gate, focus: 'movie_player' }),
    () => assertInterruptedJapaneseComposition(state, { ...gate, eventCount: 21 }),
    () => assertInterruptedJapaneseComposition(changed(19, { trusted: false }), gate),
    () => assertInterruptedJapaneseComposition(changed(21, { trusted: false }), gate),
    () => assertInterruptedJapaneseComposition(changed(25, { data: 'unrelated ' }), gate),
    () => assertInterruptedJapaneseComposition(changed(27, { trusted: false }), gate),
    () => assertInterruptedJapaneseComposition(changed(29, { data: 'unrelated' }), gate),
    () => assertInterruptedJapaneseComposition(changed(33, { data: 'unrelated ご' }), gate),
    () =>
      assertInterruptedJapaneseComposition(
        {
          ...state,
          events: events.map((event, index) =>
            index === 39 || index === 43 ? { ...event, trusted: false } : event
          ),
        },
        gate
      ),
    () => assertInterruptedJapaneseComposition(changed(44, { data: 'different' }), gate),
    () => assertInterruptedJapaneseComposition({ ...state, settledInput: 'different' }, gate),
    () => assertInterruptedJapaneseComposition({ ...state, focus: 'movie_player' }, gate),
    () =>
      assertInterruptedJapaneseComposition(
        {
          ...state,
          events: [...events, { type: 'document-keydown', focus: target, trusted: true }],
        },
        gate
      ),
  ].entries())
    assert.throws(invalid[1], /./u, `Interrupted trace variant ${invalid[0]}`);
});

test('actual Enter 08 direct input gates the same native shortcut boundary', () => {
  const target = 'yt-viewing-ime-editable';
  const events = actual08Events(actual08DirectRows, target);
  const state = checkpoint({
    focus: target,
    editable: 'nihongo',
    settledEditable: 'nihongo',
    settledFocus: target,
    events,
  });
  assert.equal(japaneseDirectGateObserved(state), true);
  const gate = {
    observed: true,
    focus: target,
    editable: 'nihongo',
    eventCount: events.length,
    traceOverflow: false,
    atMs: 1000,
    overlayPaused: false,
    videoPaused: false,
    videoTime: 1,
  };
  const beforeTyping: NativeControlSample[] = [
    {
      atMs: 0,
      focus: target,
      input: '',
      editable: '',
      overlayPaused: false,
      videoPaused: false,
      videoTime: 1,
    },
  ];
  const postGate: NativeControlSample[] = Array.from({ length: 12 }, (_, index) => ({
    atMs: 1000 + index * 75,
    focus: target,
    input: '',
    editable: 'nihongo',
    overlayPaused: false,
    videoPaused: false,
    videoTime: 2 + index * 0.075,
  }));
  assert.equal(
    assertJapaneseDirectShortcut(state, [...beforeTyping, ...postGate], gate),
    'not-delivered-to-document'
  );
  const changed = (index: number, patch: Record<string, unknown>): ImeCheckpoint => ({
    ...state,
    events: events.map((event, position) => (position === index ? { ...event, ...patch } : event)),
  });
  for (const invalid of [
    { ...state, editable: 'arbitrary' },
    { ...state, editable: 'にほんご' },
    { ...state, focus: 'movie_player' },
    { ...state, traceOverflow: true },
    changed(3, { trusted: false }),
    changed(1, { isComposing: true }),
    { ...state, events: [...events, { type: 'compositionstart', target, trusted: true }] },
    { ...state, events: [...events, { type: 'document-keydown', focus: target, trusted: true }] },
  ])
    assert.equal(japaneseDirectGateObserved(invalid), false);
  for (const invalidGate of [
    undefined,
    { ...gate, observed: false },
    { ...gate, eventCount: 1 },
    { ...gate, editable: 'stale' },
  ]) {
    assert.throws(() =>
      assertJapaneseDirectShortcut(state, [...beforeTyping, ...postGate], invalidGate)
    );
  }
  assert.throws(() =>
    assertJapaneseDirectShortcut(
      state,
      [...beforeTyping, ...postGate.map((sample) => ({ ...sample, editable: 'changed' }))],
      gate
    )
  );
  assert.throws(() =>
    assertJapaneseDirectShortcut(
      { ...state, settledEditable: 'changed' },
      [...beforeTyping, ...postGate],
      gate
    )
  );
  assert.throws(() =>
    assertJapaneseDirectShortcut({ ...state, videoTime: 1 }, [...beforeTyping, ...postGate], gate)
  );
});

test('direct-control marker rejects forged requests and native ACK requires the same token', () => {
  const token = 'a'.repeat(32);
  const marker = { kind: 'direct-control', target: 'yt-viewing-ime-editable', token };
  assert.equal(directControlGateToken(JSON.stringify(marker)), token);
  for (const invalid of [
    '{',
    JSON.stringify({ ...marker, kind: 'composition' }),
    JSON.stringify({ ...marker, target: 'movie_player' }),
    JSON.stringify({ ...marker, token: 'stale-token' }),
    JSON.stringify({ ...marker, token: undefined }),
  ])
    assert.throws(() => directControlGateToken(invalid));
  const native = readFileSync(new URL('./native-ime.ps1', import.meta.url), 'utf8');
  assert.match(native, /\$gate\.allow -cne \$true -or \$gate\.token -cne \$directToken/u);
  const direct = native.slice(
    native.indexOf("'JapaneseObservedDirectCtrlSpaceRoundTrip' {"),
    native.indexOf("'JapaneseToggleProbe' {")
  );
  const word = direct.indexOf('Invoke-JapaneseWord $false');
  const requested = direct.indexOf("label = 'direct-observation-requested'");
  const acknowledged = direct.indexOf("label = 'direct-observation-acknowledged'");
  const pause = direct.indexOf("Invoke-Combo 0x11 0x20 'Ctrl-Space-pause'");
  assert(word >= 0 && requested > word && acknowledged > requested && pause > acknowledged);
  assert.doesNotMatch(
    direct,
    /Request-TargetLayout|Japanese-Shift-CapsLock|Japanese-Ctrl-CapsLock|Japanese-Alt-Backquote/u
  );
  assert.match(direct, /\$directToken = \[guid\]::NewGuid\(\)\.ToString\('N'\)/u);
});

test('fixture player Space requires one trusted event in the focused player', () => {
  const event = { type: 'fixture-native-player-space', trusted: true, focus: 'movie_player' };
  const paused = checkpoint({ focus: 'movie_player', videoPaused: true, events: [event] });
  assert.doesNotThrow(() => assertJapanesePlayerSpace(paused, true));
  assert.throws(() => assertJapanesePlayerSpace({ ...paused, events: [] }, true), /exactly one/u);
  assert.throws(
    () => assertJapanesePlayerSpace({ ...paused, events: [event, event] }, true),
    /exactly one/u
  );
  assert.throws(() =>
    assertJapanesePlayerSpace({ ...paused, events: [{ ...event, trusted: false }] }, true)
  );
  assert.throws(
    () => assertJapanesePlayerSpace({ ...paused, traceOverflow: true }, true),
    /overflowed/u
  );
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

test('player shortcut is reported unavailable when the native IME consumes both actions', () => {
  const samples: NativeControlSample[] = Array.from({ length: 12 }, (_, index) => ({
    atMs: index * 75,
    focus: 'movie_player',
    input: '한글 ',
    overlayPaused: false,
    videoPaused: false,
    videoTime: 2 + index * 0.075,
  }));
  const state = checkpoint({ focus: 'movie_player', input: '한글 ' });
  assert.equal(assertNativePlayerCtrlSpace(state, samples, '한글 '), 'unavailable-ime-consumed');
  assert.throws(
    () =>
      assertNativePlayerCtrlSpace(
        state,
        samples.map((sample) => ({ ...sample, overlayPaused: true })),
        '한글 '
      ),
    /changed during the unavailable native shortcut/u
  );
  assert.throws(
    () =>
      assertNativePlayerCtrlSpace(
        { ...state, events: [{ type: 'document-keydown', trusted: true, focus: 'movie_player' }] },
        samples,
        '한글 '
      ),
    /Expected two native Ctrl\+Space keydown events/u
  );
});
