// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Worker URL factory implementations.
 *
 * Each platform resolves worker bundle URLs differently:
 * - Userscript: Vite bundles workers as separate chunks, `new URL(..., import.meta.url)` works.
 * - Extension: Workers must come from web_accessible_resources, resolved via chrome.runtime.getURL.
 */

import type { WorkerFactory } from '@platform/types';

// ── ViteWorkerFactory ──────────────────────────────────────────────────────

/**
 * Uses `new URL(relativePath, import.meta.url)` — works in the bundled userscript
 * where Vite emits worker chunks alongside the main bundle.
 */
class ViteWorkerFactory implements WorkerFactory {
  createWorkerUrl(relativePath: string): URL {
    return new URL(relativePath, import.meta.url);
  }
}

// ── ChromeExtensionWorkerFactory ───────────────────────────────────────────

/**
 * Uses `chrome.runtime.getURL(...)` to resolve worker paths in a browser extension.
 *
 * Assumes worker bundles are placed in a `workers/` directory that is listed in
 * `web_accessible_resources` in the extension manifest.
 */
class ChromeExtensionWorkerFactory implements WorkerFactory {
  createWorkerUrl(relativePath: string): string {
    // './renderer.ts' → 'workers/renderer.js'
    const basename = relativePath.replace(/^\.\//, '').replace(/\.ts$/, '.js');
    // chrome is declared as possibly undefined; guard access
    const chromeApi =
      (typeof chrome !== 'undefined' && chrome) || (typeof browser !== 'undefined' && browser);
    if (!chromeApi) {
      throw new Error('chrome.runtime.getURL not available');
    }
    if (!chromeApi.runtime?.getURL) {
      throw new Error('chrome.runtime.getURL not available');
    }
    return chromeApi.runtime.getURL(`workers/${basename}`);
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

let cachedFactory: WorkerFactory | null = null;

/**
 * Returns the best available worker factory for the current environment.
 * Priority: chrome.runtime (extension) > import.meta.url (bundled/Vite).
 */
export function getWorkerFactory(): WorkerFactory {
  if (cachedFactory) return cachedFactory;

  if (
    (typeof chrome !== 'undefined' && chrome.runtime) ||
    (typeof browser !== 'undefined' && browser.runtime)
  ) {
    cachedFactory = new ChromeExtensionWorkerFactory();
    return cachedFactory;
  }

  cachedFactory = new ViteWorkerFactory();
  return cachedFactory;
}

/** Reset cached factory singleton for test isolation. */
export function resetWorkerFactory(): void {
  cachedFactory = null;
}
