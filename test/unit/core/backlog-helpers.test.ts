import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPriorityMessage, prioritySortOrder, sampleExponential } from '@util/backlog-helpers';
import type { ChatMessage } from '@app-types';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMessage(kind: ChatMessage['kind'] = 'text', overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    text: 'hello',
    content: [{ type: 'text', content: 'hello' }],
    kind,
    timestamp: Date.now(),
    authorType: 'normal',
    ...overrides,
  };
}

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
    expect(isNaN(result)).toBe(false);
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
