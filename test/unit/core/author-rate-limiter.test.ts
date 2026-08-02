import { describe, expect, it } from 'vitest';
import {
  findFirstTimestampAfterCutoff,
  PerAuthorRateLimiter,
} from '@media/author-rate-limiter';

describe('findFirstTimestampAfterCutoff', () => {
  it.each([
    { timestamps: [], cutoff: 5, expected: 0 },
    { timestamps: [1, 2, 3], cutoff: 0, expected: 0 },
    { timestamps: [1, 2, 3], cutoff: 2, expected: 2 },
    { timestamps: [1, 2, 3], cutoff: 3, expected: 3 },
    { timestamps: [1, 2, 2, 3], cutoff: 2, expected: 3 },
  ])('returns $expected for cutoff $cutoff', ({ timestamps, cutoff, expected }) => {
    expect(findFirstTimestampAfterCutoff(timestamps, cutoff)).toBe(expected);
  });
});

describe('PerAuthorRateLimiter', () => {
  it('does not let high burst mode loosen the strict preset', () => {
    const limiter = new PerAuthorRateLimiter(() => 'high', () => 0);
    limiter.updateConfig({ preset: 'strict' });

    expect(limiter.allow('author-1', 0)).toBe(true);
    expect(limiter.allow('author-1', 0)).toBe(true);
    expect(limiter.allow('author-1', 0)).toBe(false);
  });

  it('allows a message again after the rate-limit window expires', () => {
    let now = 0;
    const limiter = new PerAuthorRateLimiter(() => 'normal', () => now);

    for (let i = 0; i < 5; i++) {
      expect(limiter.allow('author-1', 0)).toBe(true);
    }
    expect(limiter.allow('author-1', 0)).toBe(false);

    now = 5_001;
    expect(limiter.allow('author-1', 0)).toBe(true);
  });

  it('does not rate-limit moderators, owners, or high-priority messages', () => {
    const limiter = new PerAuthorRateLimiter(() => 'extreme', () => 0);

    expect(limiter.allow('moderator', 0, 'moderator')).toBe(true);
    expect(limiter.allow('owner', 0, 'owner')).toBe(true);
    expect(limiter.allow('system', 100)).toBe(true);
    expect(limiter.size()).toBe(0);
  });

  it('clears recorded timestamps when rate limiting is disabled', () => {
    const limiter = new PerAuthorRateLimiter(() => 'normal', () => 0);

    expect(limiter.allow('author-1', 0)).toBe(true);
    expect(limiter.size()).toBe(1);

    limiter.updateConfig({ preset: 'off' });

    expect(limiter.size()).toBe(0);
    expect(limiter.allow('author-1', 0)).toBe(true);
  });

  it('applies the extreme burst limit independently per author', () => {
    const limiter = new PerAuthorRateLimiter(() => 'extreme', () => 0);

    expect(limiter.allow('author-1', 0)).toBe(true);
    expect(limiter.allow('author-1', 0)).toBe(true);
    expect(limiter.allow('author-1', 0)).toBe(false);
    expect(limiter.allow('author-2', 0)).toBe(true);
  });
});
