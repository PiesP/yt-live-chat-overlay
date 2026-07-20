// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Lightweight density indicator shown in the overlay corner when chat
 * is heavy and messages may be dropped or throttled.
 *
 * Usage:
 *   1. Create with `new DensityIndicator()`.
 *   2. Call `create(parentElement)` to attach to the DOM.
 *   3. Call `update(activeCount, maxConcurrent)` each frame.
 *   4. Call `destroy()` on teardown.
 */

import { t } from '@i18n/index';

export type DensityLevel = 'normal' | 'elevated' | 'high' | 'extreme';

interface DensityConfig {
  label: string;
  bg: string;
  color: string;
}

const DENSITY_CONFIG: Record<Exclude<DensityLevel, 'normal'>, DensityConfig> = {
  elevated: { label: t('indicator.busy'), bg: 'rgba(255,193,7,0.8)', color: '#000' },
  high: {
    label: t('indicator.heavy'),
    bg: 'rgba(255,87,34,0.85)',
    color: '#fff',
  },
  extreme: {
    label: t('indicator.overload'),
    bg: 'rgba(244,67,54,0.9)',
    color: '#fff',
  },
};

export class DensityIndicator {
  private el: HTMLDivElement | null = null;
  private currentLevel: DensityLevel = 'normal';

  /** Attach the indicator element to a parent container. */
  create(parent: HTMLElement): void {
    if (this.el) return;
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;bottom:8px;left:8px;z-index:99;' +
      'font:11px/1.4 sans-serif;padding:3px 8px;border-radius:3px;' +
      'pointer-events:none;opacity:0;transition:opacity 0.4s';
    parent.appendChild(el);
    this.el = el;
  }

  /**
   * Update the indicator based on current chat density.
   * @param activeCount Number of currently active messages on screen.
   * @param maxConcurrent Configured maximum concurrent messages.
   */
  update(activeCount: number, maxConcurrent: number): void {
    if (!this.el) return;
    const ratio = activeCount / Math.max(1, maxConcurrent);
    let level: DensityLevel;
    if (ratio > 0.85) level = 'extreme';
    else if (ratio > 0.65) level = 'high';
    else if (ratio > 0.45) level = 'elevated';
    else level = 'normal';

    if (level === this.currentLevel) return;
    this.currentLevel = level;

    if (level === 'normal') {
      this.el.style.opacity = '0';
      return;
    }

    const config = DENSITY_CONFIG[level];
    this.el.textContent = config.label;
    this.el.style.background = config.bg;
    this.el.style.color = config.color;
    this.el.style.opacity = '0.85';
  }

  /** Remove the indicator from the DOM and reset state. */
  destroy(): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    this.currentLevel = 'normal';
  }
}
