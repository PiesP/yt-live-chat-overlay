// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Chat Availability Preflight — URL-scoped DOM check state machine.
 *
 * Separates the `#chat` DOM element existence check from the full bootstrap
 * pipeline (fetchWatchHtml + ytInitialData deep-parse).  This prevents
 * VOD pages from accumulating Edge extension errors when the DOM clearly
 * indicates there is no chat panel.
 *
 * ## State machine
 *
 *   idle ──▶ settling ──▶ expected-absent  (no #chat after settle)
 *                │
 *                └──▶ idle  (data-ready / #chat appeared / URL changed)
 *
 * - `settling`: waiting for YouTube's SPA DOM to render after a page change.
 * - `expected-absent`: terminal — the current URL has no chat panel.
 *   Only resets on URL change, page/data-ready, or #chat appearing.
 *
 * Settings changes on the same URL are idempotent — they never retrigger
 * the settle or re-log.
 */

/** YouTube chat panel root element selector. */
export const CHAT_PANEL_SELECTOR = '#chat';

export type ChatPreflightState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'settling'; readonly url: string }
  | { readonly phase: 'expected-absent'; readonly url: string };

export interface ChatPreflightStateMachine {
  readonly state: ChatPreflightState;

  /** True when the preflight has determined chat is absent at this URL. */
  readonly isTerminalAbsent: boolean;

  /** True when currently waiting for DOM to settle. */
  readonly isSettling: boolean;

  /**
   * Begin a DOM settle on a new URL.
   * No-op if already in settling or expected-absent for the same URL.
   */
  startSettle(url: string): void;

  /**
   * Mark the URL as expected-absent (terminal).
   * No-op if already expected-absent for this URL.
   */
  markAbsent(url: string): void;

  /**
   * Reset to idle — called when chat panel appears in DOM
   * or when navigating to a genuinely different URL.
   */
  reset(): void;
}

/**
 * Create a new chat preflight state machine.
 */
export function createChatPreflight(): ChatPreflightStateMachine {
  let state: ChatPreflightState = { phase: 'idle' };

  return {
    get state(): ChatPreflightState {
      return state;
    },

    get isTerminalAbsent(): boolean {
      return state.phase === 'expected-absent';
    },

    get isSettling(): boolean {
      return state.phase === 'settling';
    },

    startSettle(url: string): void {
      if (state.phase === 'expected-absent' && state.url === url) {
        return; // terminal — no-op
      }
      if (state.phase === 'settling' && state.url === url) {
        return; // already settling for this URL
      }
      state = { phase: 'settling', url };
    },

    markAbsent(url: string): void {
      if (state.phase === 'expected-absent' && state.url === url) {
        return; // already terminal
      }
      state = { phase: 'expected-absent', url };
    },

    reset(): void {
      state = { phase: 'idle' };
    },
  };
}
