import { describe, it, expect } from 'vitest';
import { computeMessageOpacity } from '@renderer/shared';
import { SPEED_TIER } from '@renderer/constants';
import type { OpacityConfig } from '@renderer/shared';
import type { ChatMessage } from '@app-types';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    text: 'hello',
    content: [{ type: 'text', content: 'hello' }],
    kind: 'text',
    timestamp: Date.now(),
    authorType: 'normal',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OpacityConfig> = {}): OpacityConfig {
  return {
    baseOpacity: 1.0,
    fadeDurationMs: 300,
    invFadeDuration: 1 / 300,
    backlogOpacityMultiplier: 0.5,
    depthLayersEnabled: true,
    depthFarOpacityMul: 0.6,
    ageFadeRate: 1 / 10000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// computeMessageOpacity
// ═══════════════════════════════════════════════════════════════════════════

describe('computeMessageOpacity', () => {
  // ── Basic / base-only ─────────────────────────────────────────────────

  describe('base opacity only (no fades, no dims, no age)', () => {
    it('returns baseOpacity when no effects apply', () => {
      const msg = makeMessage();
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1, // 1 = no dim
        depthLayersEnabled: false,
        ageFadeRate: 0, // no age fade
      });
      const result = computeMessageOpacity(msg, 500, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(cfg.baseOpacity);
    });

    it('returns 0 when baseOpacity is 0', () => {
      const msg = makeMessage();
      const cfg = makeConfig({
        baseOpacity: 0,
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      const result = computeMessageOpacity(msg, 0, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });
  });

  // ── Fade-in (non-scrolling) ────────────────────────────────────────────

  describe('fade-in (non-scrolling mode)', () => {
    const cfg = makeConfig({
      fadeDurationMs: 300,
      backlogOpacityMultiplier: 1,
      depthLayersEnabled: false,
      ageFadeRate: 0,
    });

    it('applies fade-in ramp when elapsed < fadeDurationMs', () => {
      // At t=150ms (halfway through 300ms fade)
      // opacity = base * (elapsed * invFadeDuration) = 1 * (150 * 1/300) = 0.5
      const result = computeMessageOpacity(makeMessage(), 150, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(0.5, 5);
    });

    it('applies fade-in at the very start (elapsed=0)', () => {
      const result = computeMessageOpacity(makeMessage(), 0, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });

    it('reaches full opacity at exactly fadeDurationMs', () => {
      const result = computeMessageOpacity(makeMessage(), 300, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(1, 5);
    });

    it('stays at full opacity after fade-in completes (mid-life)', () => {
      const result = computeMessageOpacity(makeMessage(), 1000, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(1, 5);
    });
  });

  // ── Scrolling mode (fade-out only, no fade-in) ────────────────────────

  describe('scrolling mode (fade-out only)', () => {
    const cfg = makeConfig({
      fadeDurationMs: 300,
      backlogOpacityMultiplier: 1,
      depthLayersEnabled: false,
      ageFadeRate: 0,
    });

    it('starts at full opacity (no fade-in when scrolling)', () => {
      const result = computeMessageOpacity(makeMessage(), 0, 5000, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(1, 5);
    });

    it('stays full at mid-life when scrolling', () => {
      const result = computeMessageOpacity(makeMessage(), 1000, 5000, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(1, 5);
    });

    it('applies fade-out at the end (remaining < fadeDurationMs)', () => {
      // duration=5000, elapsed=4800, remaining=200ms, fadeDuration=300
      // opacity = base * (remaining * invFadeDuration) = 1 * (200 * 1/300) = 0.666...
      const result = computeMessageOpacity(makeMessage(), 4800, 5000, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(200 / 300, 5);
    });

    it('reaches 0 opacity exactly at duration', () => {
      const result = computeMessageOpacity(makeMessage(), 5000, 5000, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });

    it('no fade-out when remaining >= fadeDurationMs', () => {
      const result = computeMessageOpacity(makeMessage(), 4500, 5000, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(1, 5);
    });
  });

  // ── Fade-out (non-scrolling) ──────────────────────────────────────────

  describe('fade-out (non-scrolling mode)', () => {
    const cfg = makeConfig({
      fadeDurationMs: 300,
      backlogOpacityMultiplier: 1,
      depthLayersEnabled: false,
      ageFadeRate: 0,
    });

    it('applies fade-out when elapsed > duration - fadeDurationMs', () => {
      // duration=5000, elapsed=4800, remaining=200
      // opacity = 1 * (200 * 1/300) = 0.666...
      const result = computeMessageOpacity(makeMessage(), 4800, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(200 / 300, 5);
    });

    it('reaches 0 opacity exactly at duration', () => {
      const result = computeMessageOpacity(makeMessage(), 5000, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });

    it('clamps fade-out to 0 when elapsed > duration', () => {
      // remaining = 5000 - 5200 = -200, Math.max(0, -200 * 1/300) = 0
      const result = computeMessageOpacity(makeMessage(), 5200, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });

    it('combines fade-in and fade-out at boundaries (short message)', () => {
      // duration=500ms (shorter than 2*fadeDuration=600ms), elapsed=250ms (midpoint)
      // Both conditions trigger: elapsed(250) < 300 and elapsed(250) > 200
      // fade-in: 250 * 1/300 = 0.8333...
      // fade-out: (500-250) * 1/300 = 250/300 = 0.8333...
      // combined: 1 * 0.8333 * 0.8333 = 0.694...
      const shortCfg = makeConfig({ fadeDurationMs: 300, backlogOpacityMultiplier: 1, depthLayersEnabled: false, ageFadeRate: 0 });
      const result = computeMessageOpacity(makeMessage(), 250, 500, false, SPEED_TIER.NEAR, shortCfg);
      expect(result).toBeCloseTo((250 / 300) * (250 / 300), 5);
    });
  });

  // ── Backlog dimming ───────────────────────────────────────────────────

  describe('backlog dimming', () => {
    const cfg = makeConfig({
      fadeDurationMs: 0,
      backlogOpacityMultiplier: 0.5,
      depthLayersEnabled: false,
      ageFadeRate: 0,
    });

    it('applies backlogOpacityMultiplier when isBacklog is true', () => {
      const msg = makeMessage({ isBacklog: true });
      const result = computeMessageOpacity(msg, 500, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(1 * 0.5, 5);
    });

    it('does not apply backlog dim when isBacklog is false/undefined', () => {
      const msg = makeMessage({ isBacklog: false });
      const result = computeMessageOpacity(msg, 500, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(1, 5);
    });

    it('backlog dim with multiplier=1 has no effect', () => {
      const cfg1 = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      const msg = makeMessage({ isBacklog: true });
      const result = computeMessageOpacity(msg, 500, 5000, false, SPEED_TIER.NEAR, cfg1);
      expect(result).toBeCloseTo(1, 5);
    });
  });

  // ── Depth layer dimming ───────────────────────────────────────────────

  describe('depth layer dimming', () => {
    it('applies depthFarOpacityMul when depthLayersEnabled and speedTier is FAR', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: true,
        depthFarOpacityMul: 0.6,
        ageFadeRate: 0,
      });
      const result = computeMessageOpacity(makeMessage(), 500, 5000, false, SPEED_TIER.FAR, cfg);
      expect(result).toBeCloseTo(1 * 0.6, 5);
    });

    it('does not apply depth dim when depthLayersEnabled is false', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        depthFarOpacityMul: 0.6,
        ageFadeRate: 0,
      });
      const result = computeMessageOpacity(makeMessage(), 500, 5000, false, SPEED_TIER.FAR, cfg);
      expect(result).toBeCloseTo(1, 5);
    });

    it('does not apply depth dim for non-FAR speed tiers', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: true,
        depthFarOpacityMul: 0.6,
        ageFadeRate: 0,
      });
      for (const tier of [SPEED_TIER.MID, SPEED_TIER.NEAR, SPEED_TIER.BACKLOG]) {
        const result = computeMessageOpacity(makeMessage(), 500, 5000, false, tier, cfg);
        expect(result).toBeCloseTo(1, 5);
      }
    });
  });

  // ── Age fade ──────────────────────────────────────────────────────────

  describe('age fade', () => {
    it('linearly decreases opacity as elapsed time increases', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 1 / 10000, // full age-fade at 10s
      });
      // Age fade only applies when isScrolling=true
      // At t=0: ageRatio=0, opacity = 1*(1-0) = 1
      expect(computeMessageOpacity(makeMessage(), 0, 5000, true, SPEED_TIER.NEAR, cfg)).toBeCloseTo(1, 5);
      // At t=5000: ageRatio=5000/10000=0.5, opacity = 1*(1-0.5) = 0.5
      expect(computeMessageOpacity(makeMessage(), 5000, 5000, true, SPEED_TIER.NEAR, cfg)).toBeCloseTo(0.5, 5);
      // At t=10000: ageRatio=10000/10000=1.0, opacity = 1*(1-1) = 0
      expect(computeMessageOpacity(makeMessage(), 10000, 5000, true, SPEED_TIER.NEAR, cfg)).toBeCloseTo(0, 5);
    });

    it('clamps age fade at 0 (no negative opacity)', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 1 / 1000, // fast age-fade
      });
      // Age fade only applies when isScrolling=true
      const result = computeMessageOpacity(makeMessage(), 5000, 5000, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });

    it('ageFadeRate=0 means no age fade', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      const result = computeMessageOpacity(makeMessage(), 99999, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(1);
    });
  });

  // ── Combined effects ──────────────────────────────────────────────────

  describe('combined effects', () => {
    it('combines fade-in + backlog dimming', () => {
      // fade-in at 150/300 = 0.5, backlog multiplier = 0.5
      // result = 1 * 0.5 * 0.5 = 0.25
      const cfg = makeConfig({
        fadeDurationMs: 300,
        backlogOpacityMultiplier: 0.5,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      const msg = makeMessage({ isBacklog: true });
      const result = computeMessageOpacity(msg, 150, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(0.25, 5);
    });

    it('combines fade-out + backlog dimming in scrolling mode', () => {
      // scrolling: only fade-out. elapsed=190, duration=200, remaining=10, fadeDuration=100
      // fade-out: 10 * 1/100 = 0.1
      // backlog: 0.5
      // result = 1 * 0.1 * 0.5 = 0.05
      const cfg = makeConfig({
        fadeDurationMs: 100,
        invFadeDuration: 1 / 100,
        backlogOpacityMultiplier: 0.5,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      const msg = makeMessage({ isBacklog: true });
      const result = computeMessageOpacity(msg, 190, 200, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBeCloseTo(0.05, 5);
    });

    it('combines FAR tier dim + age fade', () => {
      // depthFarOpacityMul = 0.6, age at 5000/10000 = 0.5 fade
      // result = 1 * 0.6 * (1 - 0.5) = 0.3
      // Age fade only applies when isScrolling=true
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: true,
        depthFarOpacityMul: 0.6,
        ageFadeRate: 1 / 10000,
      });
      const result = computeMessageOpacity(makeMessage(), 5000, 5000, true, SPEED_TIER.FAR, cfg);
      expect(result).toBeCloseTo(0.3, 5);
    });

    it('combines fade-in + fade-out + backlog + FAR + age fade', () => {
      // When isScrolling=true: no fade-in, only fade-out
      // duration=500, elapsed=250, fadeDuration=300
      // scrolling mode: no fade-in applied
      // fade-out: remaining = 500-250 = 250, 250 < 300 → fade-out = 250/300 = 0.8333...
      // backlog: 0.5
      // FAR: 0.6
      // age: elapsed=250, rate=1/1000 → ageRatio=0.25, mult=(1-0.25)=0.75
      // result = 1 * 0.8333... * 0.5 * 0.6 * 0.75 = 0.1875
      const cfg = makeConfig({
        fadeDurationMs: 300,
        backlogOpacityMultiplier: 0.5,
        depthLayersEnabled: true,
        depthFarOpacityMul: 0.6,
        ageFadeRate: 1 / 1000,
      });
      const msg = makeMessage({ isBacklog: true });
      const result = computeMessageOpacity(msg, 250, 500, true, SPEED_TIER.FAR, cfg);
      const expected = (250 / 300) * 0.5 * 0.6 * (1 - 250 / 1000);
      expect(result).toBeCloseTo(expected, 5);
    });

    it('returns 0 when all multipliers drive opacity to 0', () => {
      const cfg = makeConfig({
        baseOpacity: 0,
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 0,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      const result = computeMessageOpacity(makeMessage(), 500, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles elapsed=0 with all effects active', () => {
      const cfg = makeConfig({
        fadeDurationMs: 300,
        backlogOpacityMultiplier: 0.5,
        depthLayersEnabled: true,
        depthFarOpacityMul: 0.6,
        ageFadeRate: 1 / 10000,
      });
      const msg = makeMessage({ isBacklog: true });
      // At t=0: fade-in * 0 = 0, so overall = 0
      const result = computeMessageOpacity(msg, 0, 5000, false, SPEED_TIER.FAR, cfg);
      expect(result).toBe(0);
    });

    it('handles duration=0', () => {
      const cfg = makeConfig({
        fadeDurationMs: 300,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      // elapsed=0, duration=0, non-scrolling:
      // fade-in: elapsed(0) < 300 → 0 * invFade = 0
      // fade-out: elapsed(0) > (0 - 300) = -300 → (0 - 0) * invFade = 0
      const result = computeMessageOpacity(makeMessage(), 0, 0, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });

    it('handles very large elapsed (beyond maxMessageAgeMs)', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 1 / 1000,
      });
      // Age fade only applies when isScrolling=true
      const result = computeMessageOpacity(makeMessage(), 1e6, 5000, true, SPEED_TIER.NEAR, cfg);
      // ageRatio = min(1, 1e6 * 1/1000) = 1 → opacity = 1 * (1-1) = 0
      expect(result).toBe(0);
    });

    it('handles zero duration with scrolling mode', () => {
      const cfg = makeConfig({
        fadeDurationMs: 300,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      // scrolling: elapsed=0, duration=0, remaining=0 < fadeDurationMs(300)
      // opacity = 1 * Math.max(0, 0 * invFadeDuration) = 0
      const result = computeMessageOpacity(makeMessage(), 0, 0, true, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(0);
    });

    it('handles fadeDurationMs=0 (no fade effects at all)', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 0,
      });
      // Non-scrolling: if(fadeDurationMs > 0) is false → skip all fade code
      const result = computeMessageOpacity(makeMessage(), 0, 5000, false, SPEED_TIER.NEAR, cfg);
      expect(result).toBe(1);

      // Scrolling: same skip
      const result2 = computeMessageOpacity(makeMessage(), 5000, 5000, true, SPEED_TIER.NEAR, cfg);
      expect(result2).toBe(1);
    });
  });

  // ── Precision / floating-point ────────────────────────────────────────

  describe('precision', () => {
    it('produces consistent results for identical inputs', () => {
      const cfg = makeConfig({
        fadeDurationMs: 300,
        backlogOpacityMultiplier: 0.5,
        depthLayersEnabled: true,
        depthFarOpacityMul: 0.6,
        ageFadeRate: 1 / 10000,
      });
      const msg = makeMessage({ isBacklog: true });
      const a = computeMessageOpacity(msg, 350, 5000, false, SPEED_TIER.FAR, cfg);
      const b = computeMessageOpacity(msg, 350, 5000, false, SPEED_TIER.FAR, cfg);
      expect(a).toBe(b);
    });

    it('monotonically decreases with age (all else equal)', () => {
      const cfg = makeConfig({
        fadeDurationMs: 0,
        backlogOpacityMultiplier: 1,
        depthLayersEnabled: false,
        ageFadeRate: 1 / 10000,
      });
      const results = [0, 1000, 2000, 3000, 4000, 5000].map((elapsed) =>
        computeMessageOpacity(makeMessage(), elapsed, 5000, false, SPEED_TIER.NEAR, cfg),
      );
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toBeLessThanOrEqual(results[i - 1]!);
      }
    });
  });
});
