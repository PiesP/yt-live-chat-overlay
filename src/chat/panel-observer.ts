// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ChatPanelObserver — detects when YouTube's chat panel (iframe) opens or closes.
 *
 * Uses a hybrid approach:
 * - MutationObserver on document.body for fast DOM structure change detection
 * - setInterval fallback (500ms) for iframe src changes, shadow DOM, and
 *   any other changes the MutationObserver might miss
 * - 300ms debounce to avoid spurious flip-flops during rapid DOM mutations
 *
 * Only text messages are extracted — SuperChat and Membership messages
 * require structured data (amount, tier, colors) that is not available
 * from DOM text content alone.
 */

import { createLogger } from '@util/logging';

const log = createLogger('[ChatPanelObserver]');

const CHAT_PANEL_SELECTORS = [
  '#chatframe',
  '#chat.ytd-live-chat-frame',
  'ytd-live-chat-frame',
] as const;

const MUTATION_CHECK_INTERVAL_MS = 500;
const STABLE_DELAY_MS = 300;

export interface ChatPanelState {
  readonly isOpen: boolean;
  readonly element: HTMLElement | null;
  readonly timestamp: number;
}

export type ChatPanelChangeCallback = (state: ChatPanelState) => void;

export class ChatPanelObserver {
  private observer: MutationObserver | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private callback: ChatPanelChangeCallback | null = null;
  private lastState: ChatPanelState | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isPaused = false;

  /** Start observing for chat panel open/close state changes. */
  start(callback: ChatPanelChangeCallback): void {
    this.callback = callback;

    // Initial check
    this.check();

    // MutationObserver for DOM structure changes (iframe insert/remove, display toggles)
    // Scoped to the YouTube layout container (#columns) instead of document.body
    // to avoid firing on every page mutation across the entire document.
    this.observer = new MutationObserver(() => this.scheduleCheck());
    const target = document.querySelector('#columns') ?? document.body;
    this.observer.observe(target, {
      childList: true,
      subtree: true,
    });

    // Interval fallback — catches iframe src changes, shadow DOM mutations,
    // and any other changes the MutationObserver misses.
    this.pollTimer = setInterval(() => this.scheduleCheck(), MUTATION_CHECK_INTERVAL_MS);

    log.info('Chat panel observer started');
  }

  /** Stop observing and clean up all listeners. */
  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.callback = null;
    this.lastState = null;
  }

  /**
   * Pause periodic polling and DOM observation while the tab is hidden.
   * Preserves callback and lastState for seamless resumption.
   */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Resume periodic polling and DOM observation when the tab becomes visible.
   * Only restarts if a callback is registered (start() was called previously).
   */
  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    if (!this.callback) return;

    // Reconnect MutationObserver (scoped to #columns, not document.body)
    this.observer = new MutationObserver(() => this.scheduleCheck());
    const target = document.querySelector('#columns') ?? document.body;
    this.observer.observe(target, {
      childList: true,
      subtree: true,
    });

    // Restart poll timer
    this.pollTimer = setInterval(() => this.scheduleCheck(), MUTATION_CHECK_INTERVAL_MS);
  }

  /** Return the last known panel state, or null if never checked. */
  getLastState(): ChatPanelState | null {
    return this.lastState;
  }

  private scheduleCheck(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.check();
    }, STABLE_DELAY_MS);
  }

  private check(): void {
    const now = performance.now();
    const element = this.findChatPanel();
    const isOpen = element !== null;

    // No-op if state unchanged
    const currentIsOpen = this.lastState?.isOpen ?? false;
    if (isOpen === currentIsOpen && element === this.lastState?.element) {
      return;
    }

    const state: ChatPanelState = { isOpen, element, timestamp: now };

    if (isOpen) {
      log.info('Chat panel opened');
    } else {
      log.info('Chat panel closed');
    }

    this.lastState = state;
    this.callback?.(state);
  }

  private findChatPanel(): HTMLElement | null {
    for (const selector of CHAT_PANEL_SELECTORS) {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el && this.isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  /**
   * Check if an element is actually visible (not display:none, not
   * zero-size, not hidden by overflow:hidden ancestor with collapsed size).
   */
  private isVisible(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    return true;
  }
}
