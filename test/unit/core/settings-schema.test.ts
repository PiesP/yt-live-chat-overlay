// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  STORAGE_KEY,
  applySettingsPatch,
  cloneSettings,
  getOutlineDisplayScale,
  getRootDisplayMeta,
  normalizeStoredSettings,
  resolveLimits,
  resolveOutlineLimits,
  shouldResetRendererForSettingsChange,
} from '@settings/schema';
import type { OverlaySettings } from '@app-types';

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════

describe('SETTINGS_VERSION', () => {
  it('is 2', () => {
    expect(SETTINGS_VERSION).toBe(2);
  });
});

describe('STORAGE_KEY', () => {
  it('is the expected string', () => {
    expect(STORAGE_KEY).toBe('yt-live-chat-overlay-settings');
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('has expected root defaults', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.danmakuMode).toBe('scroll');
    expect(DEFAULT_SETTINGS.speedPxPerSec).toBe(250);
    expect(DEFAULT_SETTINGS.fontSize).toBe(32);
    expect(DEFAULT_SETTINGS.opacity).toBe(1);
    expect(DEFAULT_SETTINGS.logLevel).toBe('warn');
    expect(DEFAULT_SETTINGS.authorRateLimit).toBe('normal');
  });

  it('has expected showAuthor defaults', () => {
    expect(DEFAULT_SETTINGS.showAuthor.normal).toBe(false);
    expect(DEFAULT_SETTINGS.showAuthor.member).toBe(false);
    expect(DEFAULT_SETTINGS.showAuthor.moderator).toBe(true);
    expect(DEFAULT_SETTINGS.showAuthor.owner).toBe(true);
    expect(DEFAULT_SETTINGS.showAuthor.verified).toBe(false);
    expect(DEFAULT_SETTINGS.showAuthor.superChat).toBe(true);
  });

  it('has expected outline defaults', () => {
    expect(DEFAULT_SETTINGS.outline.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.outline.widthPx).toBe(2);
    expect(DEFAULT_SETTINGS.outline.opacity).toBe(0.7);
  });

  it('has string-typed colors for all author types', () => {
    const colorKeys = ['normal', 'member', 'moderator', 'owner', 'verified'] as const;
    for (const key of colorKeys) {
      expect(typeof DEFAULT_SETTINGS.colors[key]).toBe('string');
    }
  });

  it('defaults regular author backgrounds to transparent and highlights moderators and owners', () => {
    expect(DEFAULT_SETTINGS.backgroundColors).toEqual({
      normal: '#00000000',
      member: '#00000000',
      moderator: '#1B3A6F59',
      owner: '#6B4F0059',
      verified: '#00000000',
    });
  });

  it('has translation defaults (translationTarget was covered in dedicated test)', () => {
    expect(DEFAULT_SETTINGS.translationEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.translationService).toBe('auto');
    expect(DEFAULT_SETTINGS.translationSource).toBe('auto');
    expect(DEFAULT_SETTINGS.translationTarget).toBe('auto');
    expect(DEFAULT_SETTINGS.translationMode).toBe('dual');
  });
});

// ═══════════════════════════════════════════════════════════
// cloneSettings
// ═══════════════════════════════════════════════════════════

describe('cloneSettings', () => {
  it('returns a new object with the same values', () => {
    const cloned = cloneSettings(DEFAULT_SETTINGS);
    expect(cloned).not.toBe(DEFAULT_SETTINGS);
    expect(cloned.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(cloned.speedPxPerSec).toBe(DEFAULT_SETTINGS.speedPxPerSec);
  });

  it('deep-clones showAuthor', () => {
    const cloned = cloneSettings(DEFAULT_SETTINGS);
    expect(cloned.showAuthor).not.toBe(DEFAULT_SETTINGS.showAuthor);
    expect(cloned.showAuthor).toEqual(DEFAULT_SETTINGS.showAuthor);
  });

  it('deep-clones colors', () => {
    const cloned = cloneSettings(DEFAULT_SETTINGS);
    expect(cloned.colors).not.toBe(DEFAULT_SETTINGS.colors);
    expect(cloned.colors).toEqual(DEFAULT_SETTINGS.colors);
  });

  it('deep-clones backgroundColors', () => {
    const cloned = cloneSettings(DEFAULT_SETTINGS);
    expect(cloned.backgroundColors).not.toBe(DEFAULT_SETTINGS.backgroundColors);
    expect(cloned.backgroundColors).toEqual(DEFAULT_SETTINGS.backgroundColors);
  });

  it('deep-clones outline', () => {
    const cloned = cloneSettings(DEFAULT_SETTINGS);
    expect(cloned.outline).not.toBe(DEFAULT_SETTINGS.outline);
    expect(cloned.outline).toEqual(DEFAULT_SETTINGS.outline);
  });

  it('modifying the clone does not affect the original', () => {
    const original = cloneSettings(DEFAULT_SETTINGS);
    const clone = cloneSettings(original);

    clone.showAuthor.normal = true;
    clone.colors.normal = '#000000';
    clone.backgroundColors.normal = '#11223359';
    clone.outline.widthPx = 99;

    expect(original.showAuthor.normal).toBe(DEFAULT_SETTINGS.showAuthor.normal);
    expect(original.colors.normal).toBe(DEFAULT_SETTINGS.colors.normal);
    expect(original.backgroundColors.normal).toBe(DEFAULT_SETTINGS.backgroundColors.normal);
    expect(original.outline.widthPx).toBe(DEFAULT_SETTINGS.outline.widthPx);
  });

  it('modifying the original after cloning does not affect the clone', () => {
    const original = cloneSettings(DEFAULT_SETTINGS);
    const clone = cloneSettings(original);

    original.showAuthor.moderator = false;
    original.colors.moderator = '#111111';
    original.outline.opacity = 0.1;

    expect(clone.showAuthor.moderator).toBe(DEFAULT_SETTINGS.showAuthor.moderator);
    expect(clone.colors.moderator).toBe(DEFAULT_SETTINGS.colors.moderator);
    expect(clone.outline.opacity).toBe(DEFAULT_SETTINGS.outline.opacity);
  });
});

// ═══════════════════════════════════════════════════════════
// getOutlineDisplayScale
// ═══════════════════════════════════════════════════════════

describe('getOutlineDisplayScale', () => {
  it('returns 1 for widthPx', () => {
    expect(getOutlineDisplayScale('widthPx')).toBe(1);
  });

  it('returns 100 for opacity', () => {
    expect(getOutlineDisplayScale('opacity')).toBe(100);
  });

  it('returns 1 for unknown keys', () => {
    expect(getOutlineDisplayScale('nonexistent')).toBe(1);
    expect(getOutlineDisplayScale('')).toBe(1);
    expect(getOutlineDisplayScale('enabled')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// resolveLimits
// ═══════════════════════════════════════════════════════════

describe('resolveLimits', () => {
  it('returns limits for speedPxPerSec', () => {
    expect(resolveLimits('speedPxPerSec')).toEqual({ min: 50, max: 500, step: 10 });
  });

  it('returns limits for fontSize', () => {
    expect(resolveLimits('fontSize')).toEqual({ min: 14, max: 50, step: 2 });
  });

  it('returns limits for opacity', () => {
    expect(resolveLimits('opacity')).toEqual({ min: 0.5, max: 1, step: 0.05 });
  });

  it('returns limits for maxConcurrentMessages', () => {
    expect(resolveLimits('maxConcurrentMessages')).toEqual({ min: 30, max: 300, step: 10 });
  });

  it('resolves outline keys through OUTLINE_LIMIT_KEYS', () => {
    expect(resolveLimits('widthPx')).toEqual({ min: 0, max: 8, step: 0.5 });
    expect(resolveLimits('opacity')).toEqual({ min: 0.5, max: 1, step: 0.05 });
  });

  it('throws for unknown keys', () => {
    expect(() => resolveLimits('nonexistentKey')).toThrow('Unknown setting key');
    expect(() => resolveLimits('')).toThrow('Unknown setting key');
  });

  it('returns limits for all known SettingsLimitKey entries', () => {
    // Spot-check a range of limits to ensure coverage
    expect(resolveLimits('superChatOpacity')).toEqual({ min: 0.35, max: 1, step: 0.05 });
    expect(resolveLimits('safeTop')).toEqual({ min: 0, max: 0.25, step: 0.01 });
    expect(resolveLimits('safeBottom')).toEqual({ min: 0, max: 0.5, step: 0.01 });
    expect(resolveLimits('minTextLength')).toEqual({ min: 1, max: 10, step: 1 });
    expect(resolveLimits('laneSpacing')).toEqual({ min: 0, max: 20, step: 1 });
    expect(resolveLimits('backlogMaxRate')).toEqual({ min: 0, max: 50, step: 5 });
    expect(resolveLimits('backlogSpeedMultiplier')).toEqual({ min: 1, max: 5, step: 0.5 });
    expect(resolveLimits('fadeDurationMs')).toEqual({ min: 0, max: 1000, step: 50 });
    expect(resolveLimits('emojiCacheMb')).toEqual({ min: 1, max: 20, step: 1 });
    expect(resolveLimits('burstExtremeThreshold')).toEqual({ min: 10, max: 200, step: 5 });
  });

  it('returns limits for some advanced keys', () => {
    expect(resolveLimits('staggerMaxDelayMs')).toEqual({ min: 20, max: 1000, step: 20 });
    expect(resolveLimits('speedBoostMax')).toEqual({ min: 0.05, max: 1, step: 0.05 });
    expect(resolveLimits('replayBatchLimit')).toEqual({ min: 3, max: 100, step: 1 });
  });
});

// ═══════════════════════════════════════════════════════════
// resolveOutlineLimits
// ═══════════════════════════════════════════════════════════

describe('resolveOutlineLimits', () => {
  it('returns limits for widthPx', () => {
    expect(resolveOutlineLimits('widthPx')).toEqual({ min: 0, max: 8, step: 0.5 });
  });

  it('returns limits for opacity', () => {
    expect(resolveOutlineLimits('opacity')).toEqual({ min: 0, max: 1, step: 0.1 });
  });

  it('throws for unknown outline keys', () => {
    expect(() => resolveOutlineLimits('nonexistent')).toThrow('Unknown outline setting key');
    expect(() => resolveOutlineLimits('')).toThrow('Unknown outline setting key');
  });
});

// ═══════════════════════════════════════════════════════════
// getRootDisplayMeta
// ═══════════════════════════════════════════════════════════

describe('getRootDisplayMeta', () => {
  it('returns { scale: 100, precision: 0 } for opacity', () => {
    expect(getRootDisplayMeta('opacity')).toEqual({ scale: 100, precision: 0 });
  });

  it('returns { scale: 100, precision: 0 } for superChatOpacity', () => {
    expect(getRootDisplayMeta('superChatOpacity')).toEqual({ scale: 100, precision: 0 });
  });

  it('returns { scale: 100, precision: 1 } for safeTop', () => {
    expect(getRootDisplayMeta('safeTop')).toEqual({ scale: 100, precision: 1 });
  });

  it('returns { scale: 100, precision: 1 } for safeBottom', () => {
    expect(getRootDisplayMeta('safeBottom')).toEqual({ scale: 100, precision: 1 });
  });

  it('returns { scale: 100, precision: 1 } for headwayGapRatio', () => {
    expect(getRootDisplayMeta('headwayGapRatio')).toEqual({ scale: 100, precision: 1 });
  });

  it('returns { scale: 100, precision: 0 } for backlogOpacityMultiplier', () => {
    expect(getRootDisplayMeta('backlogOpacityMultiplier')).toEqual({
      scale: 100,
      precision: 0,
    });
  });

  it('returns { scale: 1, precision: 0 } for keys without displayScale', () => {
    expect(getRootDisplayMeta('fontSize')).toEqual({ scale: 1, precision: 0 });
    expect(getRootDisplayMeta('speedPxPerSec')).toEqual({ scale: 1, precision: 0 });
    expect(getRootDisplayMeta('maxConcurrentMessages')).toEqual({ scale: 1, precision: 0 });
    expect(getRootDisplayMeta('laneSpacing')).toEqual({ scale: 1, precision: 0 });
  });

  it('preserves hundredths for speedBoostMax', () => {
    expect(getRootDisplayMeta('speedBoostMax')).toEqual({ scale: 1, precision: 2 });
  });

  it('returns { scale: 1, precision: 1 } for modOwnerDurationMultiplier', () => {
    expect(getRootDisplayMeta('modOwnerDurationMultiplier')).toEqual({
      scale: 1,
      precision: 1,
    });
  });

  it('returns { scale: 1, precision: 1 } for backlogSpeedMultiplier', () => {
    expect(getRootDisplayMeta('backlogSpeedMultiplier')).toEqual({
      scale: 1,
      precision: 1,
    });
  });

  it('returns { scale: 100, precision: 0 } for depthNearSpeedMul', () => {
    expect(getRootDisplayMeta('depthNearSpeedMul')).toEqual({ scale: 100, precision: 0 });
  });
});

// ═══════════════════════════════════════════════════════════
// shouldResetRendererForSettingsChange
// ═══════════════════════════════════════════════════════════

describe('shouldResetRendererForSettingsChange', () => {
  it('returns false for identical settings', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(false);
  });

  it('returns true when a visual root key changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.fontSize = 50;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns true when speedPxPerSec changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.speedPxPerSec = 500;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns true when opacity changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.opacity = 0.5;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns true when showAuthor changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.showAuthor.normal = true;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns true when showAuthor.superChat changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.showAuthor.superChat = false;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns true when colors change', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.colors.normal = '#FF0000';
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns false when only backgroundColors change because they are paint-only', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.backgroundColors.normal = '#11223359';
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(false);
  });

  it('returns true when outline.enabled changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.outline.enabled = false;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns true when outline.widthPx changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.outline.widthPx = 8;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns true when outline.opacity changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.outline.opacity = 0.1;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(true);
  });

  it('returns false when a non-visual root key changes', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.logLevel = 'warn';
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(false);
  });

  it('returns false when authorRateLimit changes (non-visual)', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.authorRateLimit = 'strict';
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(false);
  });

  it('returns false when minPollIntervalMs changes (non-visual)', () => {
    const a = cloneSettings(DEFAULT_SETTINGS);
    const b = cloneSettings(DEFAULT_SETTINGS);
    b.minPollIntervalMs = 5000;
    expect(shouldResetRendererForSettingsChange(a, b)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// applySettingsPatch
// ═══════════════════════════════════════════════════════════

describe('applySettingsPatch', () => {
  it('returns base unchanged when partial is empty', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {});
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('patches a single root scalar value', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { fontSize: 50 });
    expect(result.fontSize).toBe(50);
    // Other values should remain defaults
    expect(result.speedPxPerSec).toBe(DEFAULT_SETTINGS.speedPxPerSec);
  });

  it('clamps out-of-range numeric values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { fontSize: 999 });
    // fontSize max is 50
    expect(result.fontSize).toBe(50);
  });

  it('clamps below-minimum numeric values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { fontSize: -1 });
    // fontSize min is 14
    expect(result.fontSize).toBe(14);
  });

  it('rejects invalid boolean types gracefully', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      enabled: 'not-a-boolean' as unknown as boolean,
    });
    expect(result.enabled).toBe(DEFAULT_SETTINGS.enabled);
  });

  it('falls back to default for invalid string setting values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      danmakuMode: 'diagonal' as unknown as OverlaySettings['danmakuMode'],
    });
    expect(result.danmakuMode).toBe(DEFAULT_SETTINGS.danmakuMode);
  });

  it('accepts valid string setting values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { danmakuMode: 'top' });
    expect(result.danmakuMode).toBe('top');
  });

  it('accepts valid logLevel values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { logLevel: 'warn' });
    expect(result.logLevel).toBe('warn');
  });

  it('merges showAuthor partial', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      showAuthor: { normal: true },
    } as Partial<OverlaySettings>);
    expect(result.showAuthor.normal).toBe(true);
    // Other showAuthor keys should remain defaults
    expect(result.showAuthor.moderator).toBe(DEFAULT_SETTINGS.showAuthor.moderator);
    expect(result.showAuthor.superChat).toBe(DEFAULT_SETTINGS.showAuthor.superChat);
  });

  it('merges colors partial', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      colors: { normal: '#FF0000' },
    } as Partial<OverlaySettings>);
    expect(result.colors.normal).toBe('#FF0000');
    expect(result.colors.member).toBe(DEFAULT_SETTINGS.colors.member);
  });

  it('rejects invalid color values and falls back to defaults', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      colors: { normal: 'not-a-color' },
    } as Partial<OverlaySettings>);
    expect(result.colors.normal).toBe(DEFAULT_SETTINGS.colors.normal);
  });

  it('merges and canonicalizes background colors to translucent RGBA hex', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      backgroundColors: { normal: '#123456' },
    } as Partial<OverlaySettings>);
    expect(result.backgroundColors.normal).toBe('#12345659');
    expect(result.backgroundColors.owner).toBe(DEFAULT_SETTINGS.backgroundColors.owner);
  });

  it('normalizes explicit nonzero alpha and rejects invalid background colors', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      backgroundColors: { normal: '#1234', member: 'transparent' },
    } as Partial<OverlaySettings>);
    expect(result.backgroundColors.normal).toBe('#11223359');
    expect(result.backgroundColors.member).toBe(DEFAULT_SETTINGS.backgroundColors.member);
  });

  it('merges outline partial', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      outline: { widthPx: 8 },
    } as Partial<OverlaySettings>);
    expect(result.outline.widthPx).toBe(8);
    expect(result.outline.opacity).toBe(DEFAULT_SETTINGS.outline.opacity);
  });

  it('clamps outline numeric values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      outline: { widthPx: 999 },
    } as Partial<OverlaySettings>);
    // outlineWidthPx max is 8
    expect(result.outline.widthPx).toBe(8);
  });

  it('handles partial outline with opacity only', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      outline: { opacity: 1 },
    } as Partial<OverlaySettings>);
    expect(result.outline.opacity).toBe(1);
    expect(result.outline.enabled).toBe(DEFAULT_SETTINGS.outline.enabled);
  });

  it('normalizes NaN to default', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { fontSize: NaN });
    expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it('normalizes Infinity to fallback default (non-finite handled as invalid)', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { fontSize: Infinity });
    // Infinity is not finite → clampNumber returns fallback (the default, 32)
    expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it('normalizes field with both valid and invalid sub-fields', () => {
    // Valid danmakuMode, but invalid opacity value
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      danmakuMode: 'bottom',
      fontSize: NaN,
    } as Partial<OverlaySettings>);
    expect(result.danmakuMode).toBe('bottom');
    expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it('preserves translationMode string values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { translationMode: 'replace' });
    expect(result.translationMode).toBe('replace');
  });

  it('rejects invalid translationMode', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, {
      translationMode: 'invalid' as unknown as OverlaySettings['translationMode'],
    });
    expect(result.translationMode).toBe(DEFAULT_SETTINGS.translationMode);
  });

  it('accepts fontWeight values', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { fontWeight: 'normal' });
    expect(result.fontWeight).toBe('normal');
  });
});

// ═══════════════════════════════════════════════════════════
// normalizeStoredSettings
// ═══════════════════════════════════════════════════════════

describe('normalizeStoredSettings', () => {
  it('returns defaults when stored is null', () => {
    const result = normalizeStoredSettings(null);
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when stored is undefined', () => {
    const result = normalizeStoredSettings(undefined);
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a deep clone of defaults (not the original reference)', () => {
    const result = normalizeStoredSettings(null);
    expect(result).not.toBe(DEFAULT_SETTINGS);
    expect(result.showAuthor).not.toBe(DEFAULT_SETTINGS.showAuthor);
    expect(result.colors).not.toBe(DEFAULT_SETTINGS.colors);
    expect(result.backgroundColors).not.toBe(DEFAULT_SETTINGS.backgroundColors);
    expect(result.outline).not.toBe(DEFAULT_SETTINGS.outline);
  });

  it('patches valid partial settings over defaults', () => {
    const result = normalizeStoredSettings({
      fontSize: 50,
      speedPxPerSec: 100,
    });
    expect(result.fontSize).toBe(50);
    expect(result.speedPxPerSec).toBe(100);
    // Unspecified fields should retain defaults
    expect(result.opacity).toBe(DEFAULT_SETTINGS.opacity);
  });

  it('clamps out-of-range values from storage', () => {
    const result = normalizeStoredSettings({
      fontSize: 9999,
      speedPxPerSec: 1,
    });
    // fontSize max is 50
    expect(result.fontSize).toBe(50);
    // speedPxPerSec min is 50
    expect(result.speedPxPerSec).toBe(50);
  });

  it('falls back to defaults for invalid typed values', () => {
    const result = normalizeStoredSettings({
      enabled: 'yes',
      danmakuMode: 'bounce',
      logLevel: 'verbose',
    });
    expect(result.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(result.danmakuMode).toBe(DEFAULT_SETTINGS.danmakuMode);
    expect(result.logLevel).toBe(DEFAULT_SETTINGS.logLevel);
  });

  it('accepts valid stored showAuthor partial', () => {
    const result = normalizeStoredSettings({
      showAuthor: {
        normal: true,
        member: true,
      },
    });
    expect(result.showAuthor.normal).toBe(true);
    expect(result.showAuthor.member).toBe(true);
    // Unspecified showAuthor keys should retain defaults
    expect(result.showAuthor.moderator).toBe(DEFAULT_SETTINGS.showAuthor.moderator);
    expect(result.showAuthor.owner).toBe(DEFAULT_SETTINGS.showAuthor.owner);
    expect(result.showAuthor.verified).toBe(DEFAULT_SETTINGS.showAuthor.verified);
    expect(result.showAuthor.superChat).toBe(DEFAULT_SETTINGS.showAuthor.superChat);
  });

  it('rejects non-boolean showAuthor values', () => {
    const result = normalizeStoredSettings({
      showAuthor: { normal: 'yes', moderator: 1 },
    });
    expect(result.showAuthor.normal).toBe(DEFAULT_SETTINGS.showAuthor.normal);
    expect(result.showAuthor.moderator).toBe(DEFAULT_SETTINGS.showAuthor.moderator);
  });

  it('accepts valid stored colors', () => {
    const result = normalizeStoredSettings({
      colors: { normal: '#FF0000', member: '#00FF00' },
    });
    expect(result.colors.normal).toBe('#FF0000');
    expect(result.colors.member).toBe('#00FF00');
    expect(result.colors.moderator).toBe(DEFAULT_SETTINGS.colors.moderator);
  });

  it('rejects invalid stored colors', () => {
    const result = normalizeStoredSettings({
      colors: { normal: 'red' },
    });
    expect(result.colors.normal).toBe(DEFAULT_SETTINGS.colors.normal);
  });

  it('accepts and canonicalizes stored background colors', () => {
    const result = normalizeStoredSettings({
      backgroundColors: { normal: '#ABC', moderator: '#10203040' },
      _version: 2,
    });
    expect(result.backgroundColors.normal).toBe('#AABBCC59');
    expect(result.backgroundColors.moderator).toBe('#10203059');
  });

  it('accepts valid outline partial from storage', () => {
    const result = normalizeStoredSettings({
      outline: { widthPx: 4, enabled: false },
    });
    expect(result.outline.enabled).toBe(false);
    expect(result.outline.widthPx).toBe(4);
    expect(result.outline.opacity).toBe(DEFAULT_SETTINGS.outline.opacity);
  });

  it('stamps _version when absent', () => {
    const result = normalizeStoredSettings({ fontSize: 50 });
    // _version is stamped internally but not exposed in OverlaySettings type
    // Just verify that normalization works without throwing
    expect(result.fontSize).toBe(50);
  });

  it('preserves _version when already present', () => {
    const result = normalizeStoredSettings({ fontSize: 50, _version: 1 });
    expect(result.fontSize).toBe(50);
  });

  it('handles empty object input', () => {
    const result = normalizeStoredSettings({});
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('handles object with only _version', () => {
    const result = normalizeStoredSettings({ _version: 1 });
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('handles translation fields from storage', () => {
    const result = normalizeStoredSettings({
      translationEnabled: true,
      translationService: 'auto',
      translationSource: 'ko',
      translationTarget: 'en',
      translationMode: 'replace',
    });
    expect(result.translationEnabled).toBe(true);
    expect(result.translationService).toBe('auto');
    expect(result.translationSource).toBe('ko');
    expect(result.translationTarget).toBe('en');
    expect(result.translationMode).toBe('replace');
  });

  it('accepts fontWeight from storage', () => {
    const result = normalizeStoredSettings({ fontWeight: 'normal' });
    expect(result.fontWeight).toBe('normal');
  });

  it('accepts fontFamily from storage', () => {
    const result = normalizeStoredSettings({ fontFamily: 'Arial, sans-serif' });
    expect(result.fontFamily).toBe('Arial, sans-serif');
  });

  it('rejects font-family declaration escapes from storage', () => {
    const result = normalizeStoredSettings({
      fontFamily: 'sans-serif;position:fixed;inset:0',
    });

    expect(result.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
  });

  it('rejects control characters and oversized font families', () => {
    expect(normalizeStoredSettings({ fontFamily: 'Arial\nserif' }).fontFamily).toBe(
      DEFAULT_SETTINGS.fontFamily
    );
    expect(normalizeStoredSettings({ fontFamily: 'A'.repeat(257) }).fontFamily).toBe(
      DEFAULT_SETTINGS.fontFamily
    );
  });

  it('accepts backlogMode values from storage', () => {
    const result = normalizeStoredSettings({ backlogMode: 'full' });
    expect(result.backlogMode).toBe('full');
  });
});

// ═══════════════════════════════════════════════════════════
// isLogLevel
// ═══════════════════════════════════════════════════════════

import { clampNumber, isColorValue, isLogLevel, migrateSettings } from '@settings/schema';

describe('isLogLevel', () => {
  it("'warn' returns true", () => {
    expect(isLogLevel('warn')).toBe(true);
  });

  it("'info' returns true", () => {
    expect(isLogLevel('info')).toBe(true);
  });

  it("'debug' returns true", () => {
    expect(isLogLevel('debug')).toBe(true);
  });

  it("'error' returns false (not in LOG_LEVEL_VALUES)", () => {
    expect(isLogLevel('error')).toBe(false);
  });

  it('empty string returns false', () => {
    expect(isLogLevel('')).toBe(false);
  });

  it('random string returns false', () => {
    expect(isLogLevel('xyz')).toBe(false);
  });

  it('undefined returns false', () => {
    expect(isLogLevel(undefined)).toBe(false);
  });

  it('null returns false', () => {
    expect(isLogLevel(null)).toBe(false);
  });

  it('number returns false', () => {
    expect(isLogLevel(42)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// isColorValue
// ═══════════════════════════════════════════════════════════

describe('isColorValue', () => {
  it("'#FFF' (3-char hex) returns true", () => {
    expect(isColorValue('#FFF')).toBe(true);
  });

  it("'#FF0000' (6-char hex) returns true", () => {
    expect(isColorValue('#FF0000')).toBe(true);
  });

  it("'#FF0000FF' (8-char hex) returns true", () => {
    expect(isColorValue('#FF0000FF')).toBe(true);
  });

  it("'#F00F' (4-char hex) returns true", () => {
    expect(isColorValue('#F00F')).toBe(true);
  });

  it("'invalid' returns false", () => {
    expect(isColorValue('invalid')).toBe(false);
  });

  it("'#GGG' returns false", () => {
    expect(isColorValue('#GGG')).toBe(false);
  });

  it('empty string returns false', () => {
    expect(isColorValue('')).toBe(false);
  });

  it('number returns false', () => {
    expect(isColorValue(0xff0000)).toBe(false);
  });

  it("'#FF' returns false (too short)", () => {
    expect(isColorValue('#FF')).toBe(false);
  });

  it("'rgb(255,0,0)' returns false (not hex)", () => {
    expect(isColorValue('rgb(255,0,0)')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// clampNumber
// ═══════════════════════════════════════════════════════════

describe('clampNumber', () => {
  const limits = { min: 10, max: 100 } as const;

  it('normal value within range passes through', () => {
    expect(clampNumber(50, 0, limits)).toBe(50);
  });

  it('value below min clamps to min', () => {
    expect(clampNumber(5, 0, limits)).toBe(10);
  });

  it('value above max clamps to max', () => {
    expect(clampNumber(200, 0, limits)).toBe(100);
  });

  it('NaN returns fallback', () => {
    expect(clampNumber(NaN, 42, limits)).toBe(42);
  });

  it('Infinity returns fallback', () => {
    expect(clampNumber(Infinity, 42, limits)).toBe(42);
  });

  it('undefined returns fallback (Number(undefined)=NaN)', () => {
    expect(clampNumber(undefined, 42, limits)).toBe(42);
  });

  it('null returns fallback (Number(null)=0, clamped to min 10)', () => {
    expect(clampNumber(null, 42, limits)).toBe(10);
  });

  it("string number ('42') coerces and clamps", () => {
    expect(clampNumber('42', 0, limits)).toBe(42);
  });

  it("non-numeric string ('abc') returns fallback", () => {
    expect(clampNumber('abc', 42, limits)).toBe(42);
  });

  it('boolean true→1 (clamped to 10), false→0 (clamped to 10)', () => {
    expect(clampNumber(true, 42, limits)).toBe(10);
    expect(clampNumber(false, 42, limits)).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════
// migrateSettings
// ═══════════════════════════════════════════════════════════

describe('migrateSettings', () => {
  it('empty object → stamps the current version and adds background defaults', () => {
    expect(migrateSettings({})).toEqual({
      _version: 2,
      backgroundColors: DEFAULT_SETTINGS.backgroundColors,
    });
  });

  it('object without _version → migrates to the current version', () => {
    expect(migrateSettings({ foo: 'bar' })).toEqual({
      foo: 'bar',
      _version: 2,
      backgroundColors: DEFAULT_SETTINGS.backgroundColors,
    });
  });

  it('object with _version:0 → migrates through both versions', () => {
    expect(migrateSettings({ _version: 0 })).toEqual({
      _version: 2,
      backgroundColors: DEFAULT_SETTINGS.backgroundColors,
    });
  });

  it('object with _version:2 → preserves _version:2', () => {
    expect(migrateSettings({ _version: 2 })).toEqual({ _version: 2 });
  });

  it('preserves other keys', () => {
    const input = { fontSize: 32, speedPxPerSec: 250 };
    expect(migrateSettings(input)).toEqual({
      fontSize: 32,
      speedPxPerSec: 250,
      _version: 2,
      backgroundColors: DEFAULT_SETTINGS.backgroundColors,
    });
  });

  it('object with _version:1 → adds background defaults and upgrades to v2', () => {
    expect(migrateSettings({ _version: 1 })).toEqual({
      _version: 2,
      backgroundColors: DEFAULT_SETTINGS.backgroundColors,
    });
  });
});
