// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureChatAction, qualifiesWorkerTranslationProof } from './translation-runtime.ts';

test('lifetime fixture uses parser-supported paid cards and same-ID replacement actions', () => {
  const held = fixtureChatAction('lifetime-held');
  const replacedHeld = fixtureChatAction('lifetime-held-replace');
  const queued = fixtureChatAction('lifetime-queued');
  const replacedQueued = fixtureChatAction('lifetime-replace');

  assert.deepEqual(Object.keys(held), ['addChatItemAction']);
  assert.deepEqual(Object.keys(replacedHeld), ['replaceChatItemAction']);
  assert.deepEqual(Object.keys(queued), ['addChatItemAction']);
  assert.deepEqual(Object.keys(replacedQueued), ['replaceChatItemAction']);

  const heldItem = (held.addChatItemAction as { item: Record<string, unknown> }).item;
  const replacedHeldItem = (replacedHeld.replaceChatItemAction as { item: Record<string, unknown> })
    .item;
  const queuedItem = (queued.addChatItemAction as { item: Record<string, unknown> }).item;
  const replacedQueuedItem = (
    replacedQueued.replaceChatItemAction as { item: Record<string, unknown> }
  ).item;
  assert.equal((heldItem.liveChatPaidMessageRenderer as { id: string }).id, 'lifetime-held');
  assert.equal(
    (replacedHeldItem.liveChatPaidMessageRenderer as { id: string }).id,
    'lifetime-held'
  );
  assert.equal((queuedItem.liveChatTextMessageRenderer as { id: string }).id, 'lifetime-queued');
  assert.equal(
    (replacedQueuedItem.liveChatTextMessageRenderer as { id: string }).id,
    'lifetime-queued'
  );
  assert.match(JSON.stringify(heldItem), /안녕하세요 日本語/u);
  assert.match(JSON.stringify(queuedItem), /مرحبا emoji 🎉/u);
});

test('Worker proof requires adopted geometry and translated-band pixels, not outbound update alone', () => {
  const baseline = { startX: 200, y: 30, width: 100, height: 80 };
  const update = { width: 100, height: 120, translationHeight: 40, arabicMarker: true };
  const visible = { status: 'sampled' as const, addedAlphaPixels: 60, glyphEdges: 30 };
  assert.equal(qualifiesWorkerTranslationProof(baseline, baseline, update, visible), false);
  assert.equal(
    qualifiesWorkerTranslationProof(baseline, { ...baseline, height: 120 }, update, {
      status: 'unavailable',
      addedAlphaPixels: 0,
      glyphEdges: 0,
    }),
    false
  );
  assert.equal(
    qualifiesWorkerTranslationProof(baseline, { ...baseline, height: 120, y: 60 }, update, visible),
    false
  );
  assert.equal(
    qualifiesWorkerTranslationProof(baseline, { ...baseline, height: 120 }, update, visible),
    true
  );
});
