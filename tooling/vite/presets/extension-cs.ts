/**
 * Extension Content Script build preset.
 *
 * IIFE format for Chrome/Firefox MV3 content scripts injected into
 * the page's MAIN world (cannot use ES module syntax).
 *
 * @module tooling/vite/presets/extension-cs
 */

import type { UserConfig } from 'vite';

export const extensionCsPreset: UserConfig = {
  build: {
    target: 'es2023',
    minify: false,
    sourcemap: false,
    emptyOutDir: false,
    // Don't clear — background/workers already built.
  },

  define: {
    // Suppress import.meta warning in IIFE build — ChromeExtensionWorkerFactory
    // is selected by getWorkerFactory() in extension context, so ViteWorkerFactory
    // (which uses import.meta.url) never executes at runtime.
    'import.meta': JSON.stringify({}),
  },
};
