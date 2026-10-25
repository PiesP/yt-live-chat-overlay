// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';

import {
  canContinueNativeProbe,
  classifyNativeCase,
  installIsolatedProbe,
  parseTranslatorNativeSelector,
  type CaseResult,
} from './translator-native-cancellation.ts';

test('isolated-world injection function is self-contained JavaScript', () => {
  const source = installIsolatedProbe.toString();
  assert.doesNotThrow(() => new Script(`(${source})`));
  assert.match(source, /document\.querySelector/u);
  assert.match(source, /Translator/u);
  assert.match(source, /runtime\?\.id/u);
});

test('preaborted creation requires its own exact focused selector', () => {
  assert.equal(
    parseTranslatorNativeSelector({ scenario: 'translator-native-cancellation' }),
    'normal'
  );
  assert.equal(
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      case: 'preaborted-create',
    }),
    'preaborted-create'
  );
  assert.throws(() =>
    parseTranslatorNativeSelector({
      scenario: 'translator-native-cancellation',
      case: 'create',
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
