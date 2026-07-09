// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * BacklogIndicator
 *
 * DOM-based UI overlay that shows "Loading chat history..." progress
 * during backlog injection. Auto-removes when injection completes.
 *
 * Handles:
 * 1. Creating the indicator DOM element
 * 2. Updating progress text
 * 3. Fade-out and auto-removal with delay
 *
 * Extracted from backlog-controller.ts for single-responsibility separation.
 */

import { t } from '@i18n/index';
import {
  BACKLOG_INDICATOR_BG,
  DEBUG_OVERLAY_RIGHT,
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_COLOR,
  INDICATOR_Z_INDEX,
} from '@util/design-tokens';
import { clearSafeTimeout } from '@util/dom';

export class BacklogIndicator {
  static readonly HIDE_DELAY_MS = 300;

  private indicatorEl: HTMLElement | null = null;
  private hideIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private _indicatorFadeRaf: number | null = null;

  /** Create and show the backlog indicator. No-op if already shown. */
  show(): void {
    if (this.indicatorEl) return;

    const el = document.createElement('div');
    el.id = 'yt-chat-overlay-backlog-indicator';
    el.style.cssText = `
      position: fixed; top: 40px; right: ${DEBUG_OVERLAY_RIGHT}; z-index: ${INDICATOR_Z_INDEX};
      background: ${BACKLOG_INDICATOR_BG}; color: ${DEFAULT_TEXT_COLOR};
      font: 12px/1.4 ${DEFAULT_FONT_FAMILY}; padding: 6px 10px;
      border-radius: 4px; pointer-events: none; user-select: none;
      opacity: 0; transition: opacity 0.3s ease;
    `;
    el.textContent = t('Loading chat history...');
    document.body.appendChild(el);
    this.indicatorEl = el;

    // Fade in
    this._indicatorFadeRaf = requestAnimationFrame(() => {
      el.style.opacity = '1';
      this._indicatorFadeRaf = null;
    });
  }

  /**
   * Update indicator with injection progress.
   * No-op if indicator is not currently shown.
   */
  update(processed: number, total: number): void {
    if (!this.indicatorEl) return;
    const pct = Math.round((total > 0 ? processed / total : 1) * 100);
    this.indicatorEl.textContent = `${t('Loading chat history...')} ${processed}/${total} (${pct}%)`;
  }

  /** Begin fade-out; auto-removes after HIDE_DELAY_MS. */
  hide(): void {
    if (!this.indicatorEl) return;

    // Cancel any pending fade-in rAF to prevent opacity glitch
    if (this._indicatorFadeRaf !== null) {
      cancelAnimationFrame(this._indicatorFadeRaf);
      this._indicatorFadeRaf = null;
    }

    this.indicatorEl.style.opacity = '0';
    this.hideIndicatorTimer = setTimeout(() => {
      this.hideIndicatorTimer = null;
      if (this.indicatorEl) {
        this.indicatorEl.remove();
        this.indicatorEl = null;
      }
    }, BacklogIndicator.HIDE_DELAY_MS);
  }

  /** Immediate cleanup — remove DOM, cancel timers/RAF. */
  destroy(): void {
    if (this._indicatorFadeRaf !== null) {
      cancelAnimationFrame(this._indicatorFadeRaf);
      this._indicatorFadeRaf = null;
    }
    this.hideIndicatorTimer = clearSafeTimeout(this.hideIndicatorTimer);
    if (this.indicatorEl) {
      this.indicatorEl.remove();
      this.indicatorEl = null;
    }
  }
}
