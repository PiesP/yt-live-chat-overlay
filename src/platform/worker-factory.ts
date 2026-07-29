// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Worker URL factory — single function.
 *
 * Resolves worker bundle URLs based on the environment:
 * - Extension: chrome.runtime.getURL (workers must be in web_accessible_resources)
 * - Userscript: Vite IIFE builds replace import.meta.url with {}.url (empty object),
 *   making relative URL construction impossible. Use workerSupported() to check
 *   before attempting Worker creation.
 */

/** Check whether Web Workers can be spawned in this environment. */
export function workerSupported(): boolean {
  // Extension bridge: ISOLATED content script injects a bridge object
  // before the MAIN-world page script loads, indicating extension context.
  if (window.__ytExtensionBridge?.workerSupported) return true;

  // Extension context has chrome.runtime.getURL for worker bundles.
  const chromeApi =
    (typeof chrome !== 'undefined' ? chrome : undefined) ??
    (typeof browser !== 'undefined' ? browser : undefined);
  if (chromeApi?.runtime?.getURL) return true;

  // Userscript IIFE builds: Vite replaces import.meta.url with {}.url,
  // so new URL(relative, import.meta.url) produces an invalid URL.
  // Worker bundling is not supported in this context.
  // Detect by checking whether import.meta.url is a real URL.
  // Extract to a local variable to suppress Vite's dynamic URL warning.
  const metaUrl: string = import.meta.url;
  try {
    new URL('.', metaUrl);
  } catch {
    return false;
  }
  return true;
}

/**
 * Create a URL for a render worker bundle.
 *
 * In extension context, resolves via chrome.runtime.getURL with worker bundles
 * from web_accessible_resources. Falls back to new URL(..., import.meta.url)
 * for bundled/Vite environments.
 */
export function createWorkerUrl(): string | URL {
  // Extension bridge provides a pre-resolved worker URL from the ISOLATED
  // content script, where chrome.runtime.getURL is actually available.
  if (window.__ytExtensionBridge?.workerUrl) {
    return window.__ytExtensionBridge.workerUrl;
  }

  const chromeApi =
    (typeof chrome !== 'undefined' ? chrome : undefined) ??
    (typeof browser !== 'undefined' ? browser : undefined);
  if (chromeApi?.runtime?.getURL) {
    return chromeApi.runtime.getURL('workers/renderer.js');
  }
  // Keep the source path static so Vite can discover and bundle the worker.
  return new URL('../renderer/worker/renderer.ts', import.meta.url);
}
