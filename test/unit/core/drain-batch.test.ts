import { describe, expect, it, vi } from 'vitest';
import {
  commitDrainBatch,
  createDrainBatch,
  recordDrainResult,
  selectDrainCandidates,
  nextDrainPriority,
} from '@renderer/canvas/drain-batch';

describe('Canvas drain batch bookkeeping', () => {
  it('rotates beyond repeated failures without losing or reordering the queue', () => {
    const queue = Array.from({ length: 90 }, (_, id) => ({ id, priority: 0 }));
    const cursors = new Map<number, (typeof queue)[number]>();
    const attempted = new Set<number>();
    for (let frame = 0; frame < 3; frame++) {
      const candidates = selectDrainCandidates(queue, (m) => m.priority, cursors);
      expect(candidates).toHaveLength(32);
      for (const message of candidates) {
        attempted.add(message.id);
        cursors.set(message.priority, message);
      }
    }
    expect(attempted.size).toBe(90);
    expect(queue.map((m) => m.id)).toEqual(Array.from({ length: 90 }, (_, id) => id));
  });

  it('visits high priority first and resumes another group after a time-budget interruption', () => {
    const queue = [...Array.from({ length: 40 }, (_, id) => ({ id, priority: 100 })), { id: 40, priority: 0 }];
    const priorityOf = (m: (typeof queue)[number]) => m.priority;
    const first = selectDrainCandidates(queue, priorityOf, new Map());
    expect(first[0]?.priority).toBe(100);
    expect(first.at(-1)?.priority).toBe(0);
    const resume = nextDrainPriority(first, priorityOf, 100);
    const next = selectDrainCandidates(queue, priorityOf, new Map(), 32, resume);
    expect(next[0]?.id).toBe(40);
    expect(next[1]?.priority).toBe(100);
  });

  it('advances after the last attempted group when a frame can afford two of three groups', () => {
    const queue = [{ priority: 200 }, { priority: 100 }, { priority: 0 }];
    const priorityOf = (m: (typeof queue)[number]) => m.priority;
    const first = selectDrainCandidates(queue, priorityOf, new Map());
    const resume = nextDrainPriority(first, priorityOf, 100);
    expect(resume).toBe(0);
    const next = selectDrainCandidates(queue, priorityOf, new Map(), 32, resume);
    expect(next.map(priorityOf)).toEqual([0, 200, 100]);
  });

  it('records placed, oversized, and transient results without reordering', () => {
    const messages = ['placed-a', 'oversized', 'transient', 'placed-b'];
    const batch = createDrainBatch(messages);

    expect(recordDrainResult(batch, messages[0]!, { placed: true, oversized: false })).toBe(true);
    expect(recordDrainResult(batch, messages[1]!, { placed: false, oversized: true })).toBe(false);
    expect(recordDrainResult(batch, messages[2]!, { placed: false, oversized: false })).toBe(false);
    expect(recordDrainResult(batch, messages[3]!, { placed: true, oversized: false })).toBe(true);

    expect(batch.batchIndex).toBe(2);
    expect(batch.staggerCursorMs).toBe(0);
    expect(batch.committed).toEqual(['placed-a', 'placed-b']);
    expect(batch.unplaceable).toEqual(['oversized']);
  });

  it('advances the stagger cursor only for committed placements', () => {
    const batch = createDrainBatch(['first', 'transient', 'second']);

    recordDrainResult(batch, 'first', {
      placed: true,
      oversized: false,
      staggerDelayMs: 40,
    });
    recordDrainResult(batch, 'transient', {
      placed: false,
      oversized: false,
      staggerDelayMs: 80,
    });
    recordDrainResult(batch, 'second', {
      placed: true,
      oversized: false,
      staggerDelayMs: 45,
    });

    expect(batch.batchIndex).toBe(2);
    expect(batch.staggerCursorMs).toBe(45);
  });

  it('commits successful and permanently unplaceable removals separately', () => {
    const queue = { removeAll: vi.fn(() => 1) };
    const batch = createDrainBatch(['placed', 'oversized', 'transient']);
    recordDrainResult(batch, 'placed', { placed: true, oversized: false });
    recordDrainResult(batch, 'oversized', { placed: false, oversized: true });
    recordDrainResult(batch, 'transient', { placed: false, oversized: false });

    commitDrainBatch(queue, batch);

    expect(queue.removeAll).toHaveBeenNthCalledWith(1, ['placed']);
    expect(queue.removeAll).toHaveBeenNthCalledWith(2, ['oversized']);
  });
});
