/**
 * Tests for font-scaling.ts — viewport-responsive font size computation.
 */

import { describe, it, expect } from 'vitest';
import { computeEffectiveFontSize } from '@util/font-scaling';
import type { FontScalingConfig } from '@util/font-scaling';

describe('computeEffectiveFontSize', () => {
  const defaultConfig: FontScalingConfig = {
    fontSize: 20,
    fontBaseViewportHeight: 720,
    fontMinSize: 10,
    fontMaxSize: 40,
  };

  it('returns base font size when viewport height matches base viewport', () => {
    const result = computeEffectiveFontSize(defaultConfig, 720);
    expect(result).toBe(20);
  });

  it('scales up proportionally for larger viewports', () => {
    const result = computeEffectiveFontSize(defaultConfig, 1440); // 2x
    // 20 * (1440/720) = 40, clamped to max 40
    expect(result).toBe(40);
  });

  it('scales down proportionally for smaller viewports', () => {
    const result = computeEffectiveFontSize(defaultConfig, 360); // 0.5x
    // 20 * (360/720) = 10, clamped to min 10
    expect(result).toBe(10);
  });

  it('clamps to fontMaxSize when viewport is very large', () => {
    const result = computeEffectiveFontSize(defaultConfig, 10000);
    // 20 * (10000/720) ≈ 277.8 → clamped to 40
    expect(result).toBe(40);
  });

  it('clamps to fontMinSize when viewport is very small', () => {
    const result = computeEffectiveFontSize(defaultConfig, 100);
    // 20 * (100/720) ≈ 2.78 → clamped to 10
    expect(result).toBe(10);
  });

  it('returns base font size when viewportHeight is 0', () => {
    const result = computeEffectiveFontSize(defaultConfig, 0);
    expect(result).toBe(20);
  });

  it('returns base font size when viewportHeight is negative', () => {
    const result = computeEffectiveFontSize(defaultConfig, -100);
    expect(result).toBe(20);
  });

  it('rounds the computed value', () => {
    const config: FontScalingConfig = {
      fontSize: 15,
      fontBaseViewportHeight: 1000,
      fontMinSize: 5,
      fontMaxSize: 50,
    };
    // 15 * (1080/1000) = 16.2 → Math.round → 16
    expect(computeEffectiveFontSize(config, 1080)).toBe(16);
  });

  it('handles fractional viewport ratios with rounding', () => {
    const config: FontScalingConfig = {
      fontSize: 13,
      fontBaseViewportHeight: 720,
      fontMinSize: 1,
      fontMaxSize: 100,
    };
    // 13 * (900/720) = 16.25 → Math.round → 16
    expect(computeEffectiveFontSize(config, 900)).toBe(16);
    // 13 * (540/720) = 9.75 → Math.round → 10
    expect(computeEffectiveFontSize(config, 540)).toBe(10);
  });

  it('handles non-standard config values', () => {
    const config: FontScalingConfig = {
      fontSize: 24,
      fontBaseViewportHeight: 1080,
      fontMinSize: 8,
      fontMaxSize: 48,
    };
    // 24 * (1920/1080) = 42.67 → Math.round → 43 → clamped to 48? No: 43 < 48
    expect(computeEffectiveFontSize(config, 1920)).toBeGreaterThanOrEqual(40);
    expect(computeEffectiveFontSize(config, 1920)).toBeLessThanOrEqual(48);
  });
});
