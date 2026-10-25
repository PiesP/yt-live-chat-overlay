// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  fixtureChatAction,
  pollObservedValue,
  qualifiesWorkerTranslationProof,
  readInstalledTranslationWorkerSelector,
} from './translation-runtime.ts';

test('Worker snapshot polling waits for the resolved observation', async () => {
  let samples = 0;
  const motion = await pollObservedValue(
    async () => {
      samples++;
      await Promise.resolve();
      return samples === 3 ? { id: 'lifetime-paid', height: 120 } : null;
    },
    100,
    'Worker snapshot missing',
    1
  );
  assert.deepEqual(motion, { id: 'lifetime-paid', height: 120 });
  assert.equal(samples, 3);
});

test('installed Worker translation requires its own exact selector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yt-translation-worker-selector-'));
  const input = join(root, 'validation/windows/inputs/translation-runtime-worker.json');
  try {
    await mkdir(join(root, 'validation/windows/inputs'), { recursive: true });
    assert.equal(await readInstalledTranslationWorkerSelector(root), false);
    await writeFile(input, '{"scenario":"translation-runtime-worker"}');
    assert.equal(await readInstalledTranslationWorkerSelector(root), true);
    await writeFile(input, '{"scenario":"translation-runtime"}');
    await assert.rejects(readInstalledTranslationWorkerSelector(root), { code: 'ERR_ASSERTION' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    true
  );
  assert.equal(
    qualifiesWorkerTranslationProof(baseline, { ...baseline, height: 120 }, update, visible),
    true
  );
});
