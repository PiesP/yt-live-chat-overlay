import type { ChatMessage } from '@app-types';
import {
  commitDrainBatch,
  createDrainBatch,
  fairDrainStartPriority,
  HIGH_PRIORITY_SUCCESS_SHARE,
  nextDrainPriority,
  nextHigherPrioritySuccesses,
  recordDrainResult,
  selectDrainCandidates,
} from '@renderer/canvas/drain-batch';
import { enqueueWithOverflow } from '@renderer/shared';
import { HighFirstPriorityBucketQueue } from '@util/priority-bucket-queue';
import { describe, expect, it, vi } from 'vite-plus/test';

describe('Canvas drain batch bookkeeping', () => {
  it('releases displaced and committed references across repeated production overflow drains', () => {
    const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
    const makeMessage = (kind: ChatMessage['kind'], text: string): ChatMessage => ({
      kind,
      text,
      content: [{ type: 'text', content: text }],
      timestamp: 1234567890,
      authorType: 'normal',
    });
    let displaced = 0;
    let firstDisplaced: ChatMessage | undefined;
    let lastDisplaced: ChatMessage | undefined;
    for (let cycle = 0; cycle < 1000; cycle++) {
      for (let index = 0; index < 200; index++) {
        expect(
          enqueueWithOverflow(
            queue,
            makeMessage('text', `${cycle}:${index}`),
            0,
            () => {
              throw new Error('Unexpected ordinary-message drop');
            },
            200
          )
        ).toBe('enqueued');
      }
      const paid = makeMessage('superchat', `paid:${cycle}`);
      expect(
        enqueueWithOverflow(
          queue,
          paid,
          200,
          (reason, message) => {
            expect(reason).toBe('queue_replaced');
            displaced++;
            if (cycle === 0) firstDisplaced = message;
            lastDisplaced = message;
          },
          200
        )
      ).toBe('replaced');
      expect(queue.size).toBe(200);
      const batch = createDrainBatch(queue.toArray());
      for (const message of batch.candidates) {
        recordDrainResult(batch, message, { placed: true, oversized: false });
      }
      commitDrainBatch(queue, batch);
      expect(queue.size).toBe(0);
    }
    expect(displaced).toBe(1000);
    expect(firstDisplaced).toBeDefined();
    expect(lastDisplaced).toBeDefined();
    const buckets = Reflect.get(queue, 'buckets') as Map<
      number,
      { msgs: (ChatMessage | undefined)[]; offset: number }
    >;
    const ordinary = buckets.get(0);
    expect(ordinary?.msgs).toHaveLength(0);
    expect(ordinary?.offset).toBe(0);
    expect(ordinary?.msgs).not.toContain(firstDisplaced);
    expect(ordinary?.msgs).not.toContain(lastDisplaced);
  });

  it('bounds backing slots through repeated partial commits, head eviction, trim, and reuse', () => {
    const queue = new HighFirstPriorityBucketQueue<{ id: number }>();
    const live: { id: number }[] = [];
    const buckets = Reflect.get(queue, 'buckets') as Map<
      number,
      { msgs: ({ id: number } | undefined)[]; offset: number }
    >;
    for (let cycle = 0; cycle < 250; cycle++) {
      for (let index = 0; index < 8; index++) {
        const message = { id: cycle * 8 + index };
        queue.enqueue(message, 0);
        live.push(message);
      }
      expect(queue.dropLowest()).toBe(live.shift());
      const batch = createDrainBatch(queue.toArray().slice(0, 6));
      for (const [index, message] of batch.candidates.entries()) {
        recordDrainResult(batch, message, {
          placed: index < 2,
          oversized: index >= 2 && index < 4,
        });
      }
      commitDrainBatch(queue, batch);
      live.splice(0, 4);
      queue.trim(20);
      live.length = Math.min(live.length, 20);
      expect(queue.size).toBe(live.length);
      expect(queue.toArray().every((message, index) => message === live[index])).toBe(true);
      const bucket = buckets.get(0);
      expect(bucket?.msgs.filter((message) => message !== undefined)).toEqual(live);
      expect(bucket?.msgs.length).toBeLessThanOrEqual(2 * live.length);
    }
    const finalBatch = createDrainBatch(queue.toArray());
    for (const message of finalBatch.candidates) {
      recordDrainResult(finalBatch, message, { placed: true, oversized: false });
    }
    commitDrainBatch(queue, finalBatch);
    expect(queue.size).toBe(0);
    expect(buckets.get(0)).toEqual({ msgs: [], offset: 0 });
    const reused = { id: 9999 };
    queue.enqueue(reused, 0);
    expect(queue.dequeue()).toBe(reused);
    expect(buckets.get(0)).toEqual({ msgs: [], offset: 0 });
    queue.enqueue({ id: 10000 }, 0);
    queue.clear();
    expect(queue.toArray()).toEqual([]);
    expect(buckets.size).toBe(0);
  });
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
    const queue = [
      ...Array.from({ length: 40 }, (_, id) => ({ id, priority: 100 })),
      { id: 40, priority: 0 },
    ];
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

  it('compares successful-service shares under twelve one-vacancy paid cycles', () => {
    const trace = (share: number | null) => {
      const pending: Array<{ id: string; priority: number }> = [];
      const visible: Array<{ id: string; cycle: number }> = [];
      let highSuccesses = 0;
      for (let cycle = 0; cycle < 12; cycle++) {
        pending.push({ id: `paid-${cycle}`, priority: 200 });
        pending.push({ id: `ordinary-${cycle}`, priority: 0 });
        const resume = share !== null && highSuccesses >= share ? 0 : undefined;
        const selected = selectDrainCandidates(
          pending,
          (entry) => entry.priority,
          new Map(),
          32,
          resume
        )[0];
        expect(selected).toBeDefined();
        if (!selected) break;
        pending.splice(pending.indexOf(selected), 1);
        visible.push({ id: selected.id, cycle });
        highSuccesses = selected.priority === 0 ? 0 : Math.min(share ?? 12, highSuccesses + 1);
      }
      return {
        paid: visible.filter((entry) => entry.id.startsWith('paid-')).length,
        ordinary: visible.filter((entry) => entry.id.startsWith('ordinary-')).length,
        firstOrdinaryCycle: visible.find((entry) => entry.id.startsWith('ordinary-'))?.cycle,
        pending: pending.length,
      };
    };
    expect(trace(null)).toEqual({
      paid: 12,
      ordinary: 0,
      firstOrdinaryCycle: undefined,
      pending: 12,
    });
    expect(trace(1)).toEqual({ paid: 6, ordinary: 6, firstOrdinaryCycle: 1, pending: 12 });
    expect(trace(2)).toEqual({ paid: 8, ordinary: 4, firstOrdinaryCycle: 2, pending: 12 });
    expect(trace(4)).toEqual({ paid: 10, ordinary: 2, firstOrdinaryCycle: 4, pending: 12 });
    expect(HIGH_PRIORITY_SUCCESS_SHARE).toBe(2);
    expect(fairDrainStartPriority([200, 0], 2)).toBe(0);
    expect(fairDrainStartPriority([200, 0], 2, 200)).toBe(200);
    expect(fairDrainStartPriority([200, -50], 2)).toBeUndefined();
    expect(nextHigherPrioritySuccesses(1, 200)).toBe(2);
    expect(nextHigherPrioritySuccesses(2, 0)).toBe(0);
    expect(nextHigherPrioritySuccesses(2, -50)).toBe(2);
  });

  it('keeps one admitted ordinary at capacity and replaces stale equal-priority ordinary', () => {
    const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
    const make = (id: string, kind: ChatMessage['kind'], isBacklog = false): ChatMessage => ({
      id,
      kind,
      isBacklog,
      text: id,
      content: [{ type: 'text', content: id }],
      timestamp: 0,
      authorType: 'normal',
    });
    const drops: string[] = [];
    const enqueue = (message: ChatMessage, priority: number) =>
      enqueueWithOverflow(
        queue,
        message,
        priority,
        (_reason, discarded) => {
          drops.push(discarded.id ?? '');
        },
        2
      );
    expect(enqueue(make('old-ordinary', 'text'), 0)).toBe('enqueued');
    expect(enqueue(make('paid-1', 'superchat'), 200)).toBe('enqueued');
    expect(enqueue(make('paid-2', 'superchat'), 200)).toBe('dropped');
    expect(enqueue(make('fresh-ordinary', 'text'), 0)).toBe('replaced');
    expect(queue.toArray().map((entry) => entry.id)).toEqual(['paid-1', 'fresh-ordinary']);
    expect(drops).toEqual(['paid-2', 'old-ordinary']);

    queue.clear();
    expect(enqueue(make('backlog-old', 'text', true), -50)).toBe('enqueued');
    expect(enqueue(make('backlog-new', 'text', true), -50)).toBe('enqueued');
    expect(enqueue(make('backlog-latest', 'text', true), -50)).toBe('dropped');

    queue.clear();
    expect(enqueue({ ...make('due-replay-old', 'text'), videoOffsetMs: 100 }, 0)).toBe('enqueued');
    expect(enqueue({ ...make('due-replay-new', 'text'), videoOffsetMs: 200 }, 0)).toBe('enqueued');
    expect(enqueue({ ...make('due-replay-latest', 'text'), videoOffsetMs: 300 }, 0)).toBe(
      'replaced'
    );
    expect(queue.toArray().map((entry) => entry.id)).toEqual([
      'due-replay-new',
      'due-replay-latest',
    ]);
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
