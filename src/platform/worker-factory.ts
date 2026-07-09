// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Worker URL factory — single function.
 *
 * Resolves worker bundle URLs based on the environment:
 * - Extension: chrome.runtime.getURL (workers must be in web_accessible_resources)
 * - Userscript: new URL(..., import.meta.url) (Vite emits worker chunks)
 */

/**
 * Create a URL for a render worker bundle.
 *
 * In extension context, resolves via chrome.runtime.getURL with worker bundles
 * from web_accessible_resources. Falls back to new URL(..., import.meta.url)
 * for bundled/Vite environments.
 */
export function createWorkerUrl(relativePath: string): string | URL {
  const chromeApi =
    (typeof chrome !== 'undefined' ? chrome : undefined) ??
    (typeof browser !== 'undefined' ? browser : undefined);
  if (chromeApi?.runtime?.getURL) {
    const basename = relativePath.replace(/^\.\//, '').replace(/\.ts$/i, '.js');
    return chromeApi.runtime.getURL(`workers/${basename}`);
  }
  return new URL(relativePath, import.meta.url);
}
