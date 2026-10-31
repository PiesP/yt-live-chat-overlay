import type { ChatMessage } from '@app-types';
import { isPriorityMessage, prioritySortOrder, sampleExponential } from '@util/backlog-helpers';
import { BacklogSampler } from '@util/backlog-sampler';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMessage(
  kind: ChatMessage['kind'] = 'text',
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    text: 'hello',
    content: [{ type: 'text', content: 'hello' }],
    kind,
    timestamp: Date.now(),
    authorType: 'normal',
    ...overrides,
  };
}

describe('BacklogSampler candidate coverage', () => {
  const sampler = new BacklogSampler();
  const messages = (count: number): ChatMessage[] =>
    Array.from({ length: count }, (_, index) =>
      makeMessage('text', { id: String(index), timestamp: index, text: 'ordinary message' })
    );

  it.each([
    { input: 199, selected: 199 },
    { input: 200, selected: 120 },
    { input: 499, selected: 299 },
    { input: 500, selected: 175 },
  ])('covers both endpoints for $input candidates', ({ input, selected }) => {
    const picked = sampler.sampleMessages(messages(input));
    expect(picked).toHaveLength(selected);
    expect(picked[0]?.id).toBe('0');
    expect(picked.at(-1)?.id).toBe(String(input - 1));
    expect(new Set(picked.map((message) => message.id)).size).toBe(selected);
  });

  it('uses message ranks across irregular timestamps and favors the latest for one slot', () => {
    const input = messages(6).map((message, index) => ({
      ...message,
      timestamp: [0, 1, 2, 3, 10_000, 100_000][index] ?? 0,
    }));
    expect(sampler.rankDistributedPick(input, 3).map((message) => message.id)).toEqual([
      '0',
      '2',
      '5',
    ]);
    expect(sampler.rankDistributedPick(input, 1)[0]?.id).toBe('5');
    expect(sampler.rankDistributedPick(input, 0)).toEqual([]);
    expect(sampler.rankDistributedPick([], 1)).toEqual([]);
  });

  it('retains priority, short CJK, and emoji reactions within a bounded sample', () => {
    const input = [
      makeMessage('superchat', { id: 'priority', timestamp: 0 }),
      ...Array.from({ length: 117 }, (_, index) =>
        makeMessage('text', { id: `long-${index}`, timestamp: index + 1, text: 'ordinary text' })
      ),
      makeMessage('text', { id: 'ko', timestamp: 118, text: '좋아' }),
      makeMessage('text', { id: 'emoji', timestamp: 119, text: '👍' }),
      ...Array.from({ length: 80 }, (_, index) =>
        makeMessage('text', { id: `short-${index}`, timestamp: index + 120, text: 'a' })
      ),
    ];
    const picked = sampler.sampleMessages(input);
    expect(picked).toHaveLength(121); // 120 ordinary slots plus protected priority
    expect(picked.map((message) => message.id)).toContain('priority');
    expect(picked.map((message) => message.id)).toContain('ko');
    expect(picked.map((message) => message.id)).toContain('emoji');
  });
});

// ── isPriorityMessage ─────────────────────────────────────────────────────

describe('isPriorityMessage', () => {
  it('returns true for superchat messages', () => {
    expect(isPriorityMessage(makeMessage('superchat'))).toBe(true);
  });

  it('returns true for membership messages', () => {
    expect(isPriorityMessage(makeMessage('membership'))).toBe(true);
  });

  it('returns false for text messages', () => {
    expect(isPriorityMessage(makeMessage('text'))).toBe(false);
  });
});

// ── prioritySortOrder ─────────────────────────────────────────────────────

describe('prioritySortOrder', () => {
  it('returns 0 for superchat', () => {
    expect(prioritySortOrder('superchat')).toBe(0);
  });

  it('returns 1 for membership', () => {
    expect(prioritySortOrder('membership')).toBe(1);
  });

  it('returns 2 for text', () => {
    expect(prioritySortOrder('text')).toBe(2);
  });

  it('returns 2 for unknown kind', () => {
    expect(prioritySortOrder('unknown' as ChatMessage['kind'])).toBe(2);
  });
});

// ── sampleExponential ─────────────────────────────────────────────────────

describe('sampleExponential', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns positive value for positive mean', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const result = sampleExponential(100);
    // -100 * ln(1 - 0.5) = -100 * ln(0.5) ≈ 69.3
    expect(result).toBeGreaterThan(0);
    expect(result).toBeCloseTo(69.3, 0);
  });

  it('returns 0 for mean of 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(sampleExponential(0)).toBe(0);
  });

  it('returns very large value when random is very close to 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
    const result = sampleExponential(100);
    // -100 * ln(EPSILON) ≈ very large but finite
    expect(result).toBeGreaterThan(0);
    expect(Number.isNaN(result)).toBe(false);
    expect(result !== Infinity).toBe(true);
  });

  it('returns 0 for mean of 0 even at edge', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
    expect(sampleExponential(0)).toBe(0);
  });

  it('returns values distributed proportional to mean', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const small = sampleExponential(10);
    const large = sampleExponential(100);
    // Large mean should produce ~10x larger sample
    expect(large).toBeCloseTo(small * 10, -1);
  });
});
