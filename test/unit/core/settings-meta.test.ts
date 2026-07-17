import { describe, it, expect } from 'vitest';
import {
  getRootDisplayMeta,
  ROOT_SETTING_META,
  SHOW_AUTHOR_KEYS,
  VISUAL_ROOT_KEYS,
  AUTHOR_COLOR_KEYS,
} from '@settings/meta';

// ── getRootDisplayMeta ──────────────────────────────────────────

describe('getRootDisplayMeta', () => {
  it('returns scale and precision for opacity (percentage)', () => {
    const meta = getRootDisplayMeta('opacity');
    expect(meta).toEqual({ scale: 100, precision: 0 });
  });

  it('returns scale and precision for safeBottom', () => {
    const meta = getRootDisplayMeta('safeBottom');
    expect(meta).toEqual({ scale: 100, precision: 1 });
  });

  it('returns scale=1, precision=0 for raw numeric setting', () => {
    const meta = getRootDisplayMeta('fontSize');
    expect(meta).toEqual({ scale: 1, precision: 0 });
  });

  it('returns scale=1, precision=0 for another raw setting', () => {
    const meta = getRootDisplayMeta('queueMaxSize');
    expect(meta).toEqual({ scale: 1, precision: 0 });
  });

  it('returns scale=1, precision=1 for backlogSpeedMultiplier', () => {
    const meta = getRootDisplayMeta('backlogSpeedMultiplier');
    expect(meta).toEqual({ scale: 1, precision: 1 });
  });
});

// ── Constants ───────────────────────────────────────────────────

describe('ROOT_SETTING_META', () => {
  it('contains boolean settings', () => {
    expect(ROOT_SETTING_META.enabled).toEqual({ type: 'boolean', visual: false });
    expect(ROOT_SETTING_META.allowShortTextMessages).toEqual({ type: 'boolean', visual: true });
  });

  it('contains string settings', () => {
    expect(ROOT_SETTING_META.danmakuMode).toEqual({ type: 'string', visual: false });
    expect(ROOT_SETTING_META.logLevel).toEqual({ type: 'string', visual: false });
  });

  it('contains numeric settings with display metadata', () => {
    expect(ROOT_SETTING_META.opacity).toEqual({
      type: 'number',
      visual: true,
      displayScale: 100,
      displayPrecision: 0,
    });
  });

  it('contains numeric settings without display metadata', () => {
    expect(ROOT_SETTING_META.fontSize).toEqual({ type: 'number', visual: true });
  });
});

describe('SHOW_AUTHOR_KEYS', () => {
  it('includes all author color keys plus superChat', () => {
    expect(SHOW_AUTHOR_KEYS).toEqual([
      'normal',
      'member',
      'moderator',
      'owner',
      'verified',
      'superChat',
    ]);
  });
});

describe('AUTHOR_COLOR_KEYS', () => {
  it('includes five author types', () => {
    expect(AUTHOR_COLOR_KEYS).toEqual(['normal', 'member', 'moderator', 'owner', 'verified']);
  });
});

describe('VISUAL_ROOT_KEYS', () => {
  it('includes visual settings that trigger renderer reset', () => {
    expect(VISUAL_ROOT_KEYS).toContain('fontSize');
    expect(VISUAL_ROOT_KEYS).toContain('opacity');
    expect(VISUAL_ROOT_KEYS).toContain('speedPxPerSec');
  });

  it('does not include non-visual settings', () => {
    expect(VISUAL_ROOT_KEYS).not.toContain('enabled');
    expect(VISUAL_ROOT_KEYS).not.toContain('logLevel');
    expect(VISUAL_ROOT_KEYS).not.toContain('queueMaxSize');
  });

  it('contains expected number of visual settings', () => {
    // Verify VISUAL_ROOT_KEYS has reasonable count (should be ~25-35 visual settings)
    expect(VISUAL_ROOT_KEYS.length).toBeGreaterThan(20);
    expect(VISUAL_ROOT_KEYS.length).toBeLessThan(40);
  });
});
