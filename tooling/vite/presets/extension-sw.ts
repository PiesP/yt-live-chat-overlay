/**
 * Extension Service Worker / Background + Workers build preset.
 *
 * ES module output for Chrome/Firefox MV3 extension background script
 * and Web Worker renderer.
 *
 * @module tooling/vite/presets/extension-sw
 */

import type { UserConfig } from 'vite';

export const extensionSwPreset: UserConfig = {
  build: {
    target: 'es2023',
    // Extension SW: minify in production, sourcemap only in dev
    // minify and sourcemap are set per-mode by factories.
    emptyOutDir: true,
    copyPublicDir: false,
  },
};
