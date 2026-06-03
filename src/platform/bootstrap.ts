// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform detection and adapter bootstrap.
 *
 * Detects the runtime environment and selects the appropriate adapter
 * implementations for storage, cross-tab sync, menu commands, and worker URLs.
 */

import { getMenuAdapter } from '@platform/menu-adapters';
import type { MenuAdapter, WorkerFactory } from '@platform/types';
import { getWorkerFactory } from '@platform/worker-factory';

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

// ── Bootstrap result ───────────────────────────────────────────────────────

export interface PlatformBootstrap {
  platform: PlatformType;
  menu: MenuAdapter;
  workerFactory: WorkerFactory;
}

/**
 * Create the platform adapter bundle for the current environment.
 * Called once at application startup.
 */
export function bootstrapPlatform(): PlatformBootstrap {
  const platform = detectPlatform();

  return {
    platform,
    menu: getMenuAdapter(),
    workerFactory: getWorkerFactory(),
  };
}

// ── Browser global declaration for Firefox ─────────────────────────────────

declare const browser: { runtime?: { id?: string } } | undefined;
