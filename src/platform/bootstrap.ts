// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform detection and adapter bootstrap.
 *
 * Detects the runtime environment and selects the appropriate adapter
 * implementations for storage, cross-tab sync, menu commands, and worker URLs.
 */

// ── Platform type ──────────────────────────────────────────────────────────

export type PlatformType = 'userscript' | 'chrome-extension' | 'firefox-extension' | 'browser';

/**
 * Detect the current runtime environment.
 *
 * Chrome extensions expose `chrome.runtime.id` in content scripts.
 * Userscript managers expose `GM_getValue`.
 * Firefox extensions expose `browser.runtime.id` (WebExtensions).
 * Otherwise it's a plain browser context.
 */
export function detectPlatform(): PlatformType {
  // Chrome extension: chrome.runtime.id is a unique extension identifier
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    return 'chrome-extension';
  }

  // Firefox extension: browser.runtime.id (WebExtensions polyfill compatible)
  if (typeof browser !== 'undefined' && (browser as { runtime?: { id?: string } }).runtime?.id) {
    return 'firefox-extension';
  }

  // Userscript: GM_getValue is injected by userscript managers
  if (typeof GM_getValue !== 'undefined') {
    return 'userscript';
  }

  // Fallback: plain browser (localStorage-based, limited functionality)
  return 'browser';
}

// ── Browser global declaration for Firefox ─────────────────────────────────

declare const browser: { runtime?: { id?: string } } | undefined;
