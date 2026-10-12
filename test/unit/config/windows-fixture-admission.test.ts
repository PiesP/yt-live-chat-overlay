// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import { exactDeclaredMessageIdsReady, installFixtureWorkerProbe, readFixtureAdmissionDiagnostic } from '../../../validation/windows/profile.mjs';

const ids = ['ko', 'ja', 'rtl', 'emoji', 'paid', 'member'];

describe('installed Windows fixture admission', () => {
  it('waits for the exact duplicate-free declared ID set regardless of activation order', () => {
    let now = 100;
    let entries = ids.slice(0, 5).map((id) => ({ dataset: { messageId: id } }));
    const window: { __ytAcceptanceReadiness?: unknown } = {};
    const context = {
      window,
      document: { querySelectorAll: () => entries },
      performance: { now: () => now },
    };
    const ready = runInNewContext(`(${exactDeclaredMessageIdsReady.toString()})`, context);
    expect(ready(ids)).toBe(false);
    now = 250;
    entries = ['member', 'paid', 'emoji', 'rtl', 'ja', 'ko']
      .map((id) => ({ dataset: { messageId: id } }));
    expect(ready(ids)).toBe(true);
    expect(JSON.parse(JSON.stringify(window.__ytAcceptanceReadiness))).toEqual({
      startedAtMs: 100,
      firstSeenAtMs: { ko: 100, ja: 100, rtl: 100, emoji: 100, paid: 100, member: 250 },
      exactReadyAtMs: 250,
    });
    entries[0] = { dataset: { messageId: 'ko' } };
    expect(ready(ids)).toBe(false);
    entries[0] = { dataset: { messageId: 'unexpected' } };
    expect(ready(ids)).toBe(false);
    entries.push({ dataset: { messageId: 'member' } });
    expect(ready(ids)).toBe(false);
  });

  it('keeps timestamped Worker admission and accessibility diagnostics bounded', () => {
    let now = 10;
    const entries = [
      { dataset: { messageId: 'paid' }, textContent: 'P'.repeat(200) },
      { dataset: { messageId: 'unknown' }, textContent: 'private unrelated content' },
    ];
    class FixtureWorker {
      listeners = new Map<string, (event: { data: unknown }) => void>();
      constructor(_url: string) {}
      postMessage(_message: unknown) {}
      terminate() {}
      addEventListener(type: string, callback: (event: { data: unknown }) => void) {
        this.listeners.set(type, callback);
      }
      emit(type: string, data: unknown) { this.listeners.get(type)?.({ data }); }
    }
    const window = { Worker: FixtureWorker };
    const context = {
      window,
      document: {
        querySelectorAll: (selector: string) => selector.includes('live-region') ? entries : [],
        querySelector: () => null,
      },
      performance: { now: () => now },
    };
    runInNewContext(`(${installFixtureWorkerProbe.toString()})(${JSON.stringify(ids)})`, context);
    const worker = new window.Worker('blob:fixture');
    worker.emit('message', { type: 'ready' });
    worker.postMessage({ type: 'addMessages', messages: [{ id: 'paid' }, { id: 'unknown' }] });
    for (let index = 0; index < 20; index++) {
      now++;
      worker.emit('message', { type: 'batchReceipt', batchSequence: index,
        admittedMessages: 1, pendingQueueDepth: 1 });
      worker.emit('message', { type: 'stats', activeMessages: 1,
        pendingQueueDepth: 1, totalRendered: index, totalDrops: 0,
        processedBatchSequence: index, activeMessageIds: ['paid', 'unknown'],
        pendingMessageIds: ['member', 'unknown'] });
    }
    worker.emit('message', { type: 'stats', activeMessages: -1,
      pendingQueueDepth: 0, totalRendered: 20, totalDrops: 0,
      processedBatchSequence: 20 });
    const diagnostic = runInNewContext(
      `(${readFixtureAdmissionDiagnostic.toString()})(${JSON.stringify(ids)})`, context,
    );
    expect(diagnostic.workers).toHaveLength(1);
    expect(diagnostic.workers[0].recentReceipts).toHaveLength(16);
    expect(diagnostic.workers[0].recentStats).toHaveLength(16);
    expect(diagnostic.workers[0].recentReceipts[0]).toMatchObject({
      observedAtMs: 15, batchSequence: 4, admittedMessages: 1, pendingQueueDepth: 1,
    });
    expect(diagnostic.workers[0].recentStats.at(-1)).toMatchObject({
      observedAtMs: 30, activeDeclaredIds: ['paid'], pendingDeclaredIds: ['member'],
    });
    expect(diagnostic.workers[0].addedDeclaredIds).toEqual(['paid']);
    expect(diagnostic.accessibility).toMatchObject({
      count: 2, unexpectedCount: 1, missingIds: ['ko', 'ja', 'rtl', 'emoji', 'member'],
    });
    expect(diagnostic.accessibility.declared[0].snippet).toHaveLength(120);
    expect(JSON.stringify(diagnostic)).not.toContain('private unrelated content');
  });
});
