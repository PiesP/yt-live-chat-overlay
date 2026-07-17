import { describe, it, expect } from 'vitest';
import {
  resolveLimits,
  resolveOutlineLimits,
  getOutlineDisplayScale,
  OUTLINE_NUMERIC_KEYS,
} from '@settings/limits';

// ── resolveLimits ───────────────────────────────────────────────

describe('resolveLimits', () => {
  it('returns limits for a known root setting', () => {
    const limits = resolveLimits('fontSize');
    expect(limits).toEqual({ min: 14, max: 50, step: 2 });
  });

  it('returns limits for another root setting', () => {
    const limits = resolveLimits('opacity');
    expect(limits).toEqual({ min: 0.5, max: 1, step: 0.05 });
  });

  it('resolves outline key through OUTLINE_LIMIT_KEYS', () => {
    const limits = resolveLimits('outlineWidthPx');
    expect(limits).toEqual({ min: 0, max: 8, step: 0.5 });
  });

  it('resolves outline opacity through OUTLINE_LIMIT_KEYS', () => {
    const limits = resolveLimits('outlineOpacity');
    expect(limits).toEqual({ min: 0, max: 1, step: 0.1 });
  });

  it('throws for unknown key', () => {
    expect(() => resolveLimits('nonexistentKey')).toThrow('Unknown setting key: nonexistentKey');
  });
});

// ── resolveOutlineLimits ─────────────────────────────────────────

describe('resolveOutlineLimits', () => {
  it('returns limits for outline widthPx', () => {
    const limits = resolveOutlineLimits('widthPx');
    expect(limits).toEqual({ min: 0, max: 8, step: 0.5 });
  });

  it('returns limits for outline opacity', () => {
    const limits = resolveOutlineLimits('opacity');
    expect(limits).toEqual({ min: 0, max: 1, step: 0.1 });
  });

  it('throws for unknown outline key', () => {
    expect(() => resolveOutlineLimits('color')).toThrow('Unknown outline setting key: color');
  });
});

// ── getOutlineDisplayScale ───────────────────────────────────────

describe('getOutlineDisplayScale', () => {
  it('returns 1 for widthPx', () => {
    expect(getOutlineDisplayScale('widthPx')).toBe(1);
  });

  it('returns 100 for opacity', () => {
    expect(getOutlineDisplayScale('opacity')).toBe(100);
  });

  it('returns 1 for unknown key', () => {
    expect(getOutlineDisplayScale('color')).toBe(1);
  });
});

// ── Constants ───────────────────────────────────────────────────

describe('OUTLINE_NUMERIC_KEYS', () => {
  it('contains widthPx and opacity', () => {
    expect(OUTLINE_NUMERIC_KEYS).toEqual(['widthPx', 'opacity']);
  });
});
