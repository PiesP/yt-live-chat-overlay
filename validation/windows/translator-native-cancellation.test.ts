// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';

import {
  canContinueNativeProbe,
  classifyNativeCase,
  installNativeProbe,
  parseTranslatorNativeSelector,
  type CaseResult,
} from './translator-native-cancellation.ts';

test('both injection worlds use the same self-contained native probe', () => {
  const source = installNativeProbe.toString();
  assert.doesNotThrow(() => new Script(`(${source})`));
  assert.match(source, /document\.querySelector/u);
  assert.match(source, /Translator/u);
  assert.match(source, /runtime\?\.id/u);
});

test('native selectors require an exact case and realm, defaulting to isolated', () => {
  assert.deepEqual(parseTranslatorNativeSelector({ scenario: 'translator-native-cancellation' }), {
    case: 'normal',
    realm: 'isolated',
  });
  assert.deepEqual(
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      case: 'preaborted-create',
    }),
    { case: 'preaborted-create', realm: 'isolated' }
  );
  assert.deepEqual(
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      realm: 'main',
    }),
    { case: 'normal', realm: 'main' }
  );
  assert.deepEqual(
    parseTranslatorNativeSelector({
      realm: 'main',
      scenario: 'translator-native-cancellation',
    }),
    { case: 'normal', realm: 'main' }
  );
  assert.deepEqual(
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      case: 'preaborted-create',
      realm: 'main',
    }),
    { case: 'preaborted-create', realm: 'main' }
  );
  assert.deepEqual(
    parseTranslatorNativeSelector({
      realm: 'main',
      scenario: 'translator-native-cancellation',
      case: 'preaborted-create',
    }),
    { case: 'preaborted-create', realm: 'main' }
  );
  assert.throws(() =>
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      case: 'create',
    })
  );
  assert.throws(() =>
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      realm: 'MAIN',
    })
  );
  assert.throws(() =>
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      realm: 'isolated',
    })
  );
  assert.throws(() =>
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      realm: 'main',
      case: 'preaborted-create',
      extra: true,
    })
  );
});

function result(action: CaseResult['action'], changes: Partial<CaseResult>): CaseResult {
  return {
    action,
    settlement: 'rejected',
    elapsedMs: 20,
    errorName: 'AbortError',
    output: null,
    input: null,
    userActivationAtClick: true,
    ...changes,
  };
}

test('unknown native settlement stops the next case even after an observation deadline', () => {
  const unknown = result('mid-translate-abort', { settlement: 'unknown', abortRequestedMs: 1 });
  assert.equal(canContinueNativeProbe(unknown), false);
  assert.equal(classifyNativeCase(unknown), 'inconclusive');
});

test('preaborted calls expose ignored and expected JavaScript settlement separately', () => {
  assert.equal(classifyNativeCase(result('preaborted-create', {})), 'expected-js-settlement');
  assert.equal(
    classifyNativeCase(result('preaborted-translate', { settlement: 'fulfilled' })),
    'ignored'
  );
  assert.equal(
    classifyNativeCase(result('preaborted-create', { errorName: 'NotSupportedError' })),
    'inconclusive'
  );
  assert.equal(
    classifyNativeCase(result('preaborted-create', { userActivationAtClick: false })),
    'inconclusive'
  );
});

test('mid-operation cancellation is inconclusive when the operation settled first', () => {
  assert.equal(
    classifyNativeCase(result('mid-translate-abort', { abortRequestedMs: 21 })),
    'inconclusive'
  );
  assert.equal(
    classifyNativeCase(result('mid-translate-abort', { abortRequestedMs: 1 })),
    'expected-js-settlement'
  );
  assert.equal(
    classifyNativeCase(
      result('mid-translate-abort', { abortRequestedMs: 1, settlement: 'fulfilled' })
    ),
    'ignored'
  );
});

test('destroy requires a pending call and a rejected call after destruction', () => {
  assert.equal(
    classifyNativeCase(
      result('destroy-pending', {
        destroyCalledMs: 1,
        unsettledAtDestroy: true,
        postdestroy: { settlement: 'rejected', errorName: 'AbortError' },
      })
    ),
    'expected-js-settlement'
  );
  assert.equal(
    classifyNativeCase(
      result('destroy-pending', {
        destroyCalledMs: 1,
        unsettledAtDestroy: true,
        postdestroy: { settlement: 'fulfilled', errorName: null },
      })
    ),
    'ignored'
  );
  assert.equal(
    classifyNativeCase(
      result('destroy-pending', {
        destroyCalledMs: null,
        unsettledAtDestroy: false,
        postdestroy: { settlement: 'rejected', errorName: 'AbortError' },
      })
    ),
    'inconclusive'
  );
  assert.equal(
    classifyNativeCase(
      result('destroy-pending', {
        destroyCalledMs: 1,
        unsettledAtDestroy: true,
        errorName: 'QuotaExceededError',
        postdestroy: { settlement: 'rejected', errorName: 'Error' },
      })
    ),
    'inconclusive'
  );
  assert.equal(
    classifyNativeCase(
      result('destroy-pending', {
        destroyCalledMs: 1,
        unsettledAtDestroy: true,
        postdestroy: { settlement: 'rejected', errorName: 'InvalidStateError' },
      })
    ),
    'inconclusive'
  );
});

test('same-object call needs a nonempty hashed output', () => {
  assert.equal(
    classifyNativeCase(
      result('same-object-translate', {
        settlement: 'fulfilled',
        errorName: null,
        output: { codepoints: 2, sha256: 'a'.repeat(64) },
      })
    ),
    'expected-js-settlement'
  );
  assert.equal(
    classifyNativeCase(
      result('same-object-translate', {
        settlement: 'fulfilled',
        errorName: null,
        output: { codepoints: 0, sha256: 'a'.repeat(64) },
      })
    ),
    'inconclusive'
  );
  assert.equal(
    classifyNativeCase(
      result('same-object-translate', {
        settlement: 'fulfilled',
        errorName: null,
        output: null,
      })
    ),
    'inconclusive'
  );
});
