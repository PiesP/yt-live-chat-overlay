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
export class ViteWorkerFactory implements WorkerFactory {
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
export class ChromeExtensionWorkerFactory implements WorkerFactory {
  createWorkerUrl(relativePath: string): string {
    // './renderer-worker.ts' → 'workers/renderer-worker.js'
    const basename = relativePath.replace(/^\.\//, '').replace(/\.ts$/, '.js');
    // chrome is declared as possibly undefined; guard access
    if (typeof chrome === 'undefined') {
      throw new Error('chrome.runtime.getURL not available');
    }
    if (!chrome.runtime) {
      throw new Error('chrome.runtime not available');
    }
    return chrome.runtime.getURL(`workers/${basename}`);
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

  if (typeof chrome !== 'undefined' && chrome.runtime) {
    cachedFactory = new ChromeExtensionWorkerFactory();
    return cachedFactory;
  }

  cachedFactory = new ViteWorkerFactory();
  return cachedFactory;
}

/** Reset cached factory (for testing). */
export function resetWorkerFactoryCache(): void {
  cachedFactory = null;
}
