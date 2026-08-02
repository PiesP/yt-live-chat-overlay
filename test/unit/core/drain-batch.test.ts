import { describe, expect, it, vi } from 'vitest';
import {
  commitDrainBatch,
  createDrainBatch,
  recordDrainResult,
} from '@renderer/canvas/drain-batch';

describe('Canvas drain batch bookkeeping', () => {
  it('records placed, oversized, and transient results without reordering', () => {
    const messages = ['placed-a', 'oversized', 'transient', 'placed-b'];
    const batch = createDrainBatch(messages);

    expect(recordDrainResult(batch, messages[0]!, { placed: true, oversized: false })).toBe(true);
    expect(recordDrainResult(batch, messages[1]!, { placed: false, oversized: true })).toBe(false);
    expect(recordDrainResult(batch, messages[2]!, { placed: false, oversized: false })).toBe(false);
    expect(recordDrainResult(batch, messages[3]!, { placed: true, oversized: false })).toBe(true);

    expect(batch.batchIndex).toBe(2);
    expect(batch.committed).toEqual(['placed-a', 'placed-b']);
    expect(batch.unplaceable).toEqual(['oversized']);
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
