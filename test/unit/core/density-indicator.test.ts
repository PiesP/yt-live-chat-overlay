/**
 * Tests for DensityIndicator — density level computation and DOM operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Pure function extracted for testing ─────────────────────────────────

/**
 * Pure function that maps activeCount / maxConcurrent ratio to a density level.
 * Extracted from DensityIndicator.update() logic.
 */
function computeDensityLevel(activeCount: number, maxConcurrent: number): 'normal' | 'elevated' | 'high' | 'extreme' {
  const ratio = activeCount / Math.max(1, maxConcurrent);
  if (ratio > 0.85) return 'extreme';
  if (ratio > 0.65) return 'high';
  if (ratio > 0.45) return 'elevated';
  return 'normal';
}

describe('computeDensityLevel (density indicator logic)', () => {
  it('returns normal when ratio ≤ 0.45', () => {
    expect(computeDensityLevel(0, 100)).toBe('normal');
    expect(computeDensityLevel(45, 100)).toBe('normal');
  });

  it('returns elevated when 0.45 < ratio ≤ 0.65', () => {
    expect(computeDensityLevel(46, 100)).toBe('elevated');
    expect(computeDensityLevel(65, 100)).toBe('elevated');
  });

  it('returns high when 0.65 < ratio ≤ 0.85', () => {
    expect(computeDensityLevel(66, 100)).toBe('high');
    expect(computeDensityLevel(85, 100)).toBe('high');
  });

  it('returns extreme when ratio > 0.85', () => {
    expect(computeDensityLevel(86, 100)).toBe('extreme');
    expect(computeDensityLevel(200, 100)).toBe('extreme');
  });

  it('handles maxConcurrent = 0 without division by zero', () => {
    expect(computeDensityLevel(1, 0)).toBe('extreme'); // 1 / max(1, 0) = 1 > 0.85
    expect(computeDensityLevel(0, 0)).toBe('normal');  // 0 / 1 = 0
  });

  it('handles maxConcurrent = 1 edge case', () => {
    expect(computeDensityLevel(0, 1)).toBe('normal');
    expect(computeDensityLevel(1, 1)).toBe('extreme'); // 1 / 1 = 1 > 0.85
  });

  it('respects ratio threshold boundaries', () => {
    // Elevation boundary: 0.45 vs 0.46
    const maxConc = 100;
    expect(computeDensityLevel(45, maxConc)).toBe('normal');
    expect(computeDensityLevel(46, maxConc)).toBe('elevated');
    // High boundary: 0.65 vs 0.66
    expect(computeDensityLevel(65, maxConc)).toBe('elevated');
    expect(computeDensityLevel(66, maxConc)).toBe('high');
    // Extreme boundary: 0.85 vs 0.86
    expect(computeDensityLevel(85, maxConc)).toBe('high');
    expect(computeDensityLevel(86, maxConc)).toBe('extreme');
  });
});

// ── DOM-based density indicator tests (jsdom) ───────────────────────────

// Import inside to avoid setup.ts logger mock interfering
import { DensityIndicator } from '@util/density-indicator';

describe('DensityIndicator (DOM operations)', () => {
  let indicator: DensityIndicator;
  let parent: HTMLElement;

  beforeEach(() => {
    indicator = new DensityIndicator();
    parent = document.createElement('div');
  });

  describe('create()', () => {
    it('appends a div to the parent element', () => {
      indicator.create(parent);
      expect(parent.children.length).toBe(1);
      const el = parent.children[0]!;
      expect(el.tagName).toBe('DIV');
    });

    it('does not create a second element when called twice', () => {
      indicator.create(parent);
      indicator.create(parent);
      expect(parent.children.length).toBe(1);
    });

    it('sets proper CSS styles on the created element', () => {
      indicator.create(parent);
      const el = parent.children[0] as HTMLDivElement;
      expect(el.style.position).toBe('absolute');
      expect(el.style.bottom).toBe('8px');
    });
  });

  describe('update()', () => {
    it('no-ops when element is not created', () => {
      // Should not throw
      expect(() => indicator.update(50, 100)).not.toThrow();
    });

    it('sets opacity to 0.85 and displays elevated config at 50%', () => {
      const ind = new DensityIndicator();
      ind.create(parent);
      const el = parent.children[0] as HTMLDivElement;

      ind.update(50, 100); // ratio 0.5 → elevated
      expect(el.style.opacity).toBe('0.85');
      expect(el.textContent).toBeTruthy(); // should have text set
    });

    it('sets opacity to 0 when density returns to normal', () => {
      const ind = new DensityIndicator();
      ind.create(parent);
      const el = parent.children[0] as HTMLDivElement;

      // First go to elevated
      ind.update(50, 100); // ratio 0.5 → elevated
      expect(el.style.opacity).toBe('0.85');

      // Then go back to normal
      ind.update(40, 100); // ratio 0.4 → normal
      expect(el.style.opacity).toBe('0');
    });

    it('skips update when level has not changed (same density)', () => {
      const ind = new DensityIndicator();
      ind.create(parent);
      const el = parent.children[0] as HTMLDivElement;

      // Go to elevated first
      ind.update(50, 100); // elevated
      expect(el.style.opacity).toBe('0.85');

      // Modify opactity manually to verify skip
      el.style.opacity = '0.5';

      // Call with same effective level (still elevated)
      ind.update(60, 100); // still elevated → should skip (no change)

      // If it skipped (level unchanged), opacity should stay 0.5
      expect(el.style.opacity).toBe('0.5');
    });
  });

  describe('destroy()', () => {
    it('removes the element from DOM', () => {
      indicator.create(parent);
      expect(parent.children.length).toBe(1);

      indicator.destroy();
      expect(parent.children.length).toBe(0);
    });

    it('is safe to call when element was never created', () => {
      expect(() => indicator.destroy()).not.toThrow();
    });

    it('is safe to call twice', () => {
      indicator.create(parent);
      indicator.destroy();
      indicator.destroy();
      expect(parent.children.length).toBe(0);
    });
  });
});
