import { describe, expect, it } from 'vitest';
import { PerAuthorRateLimiter } from '@media/author-rate-limiter';

describe('PerAuthorRateLimiter', () => {
  it('does not let high burst mode loosen the strict preset', () => {
    const limiter = new PerAuthorRateLimiter(() => 'high', () => 0);
    limiter.updateConfig({ preset: 'strict' });

    expect(limiter.allow('author-1', 0)).toBe(true);
    expect(limiter.allow('author-1', 0)).toBe(true);
    expect(limiter.allow('author-1', 0)).toBe(false);
  });
});
