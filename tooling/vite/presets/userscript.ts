/**
 * Userscript build preset for vite-plugin-monkey based output.
 *
 * Applied by the primary vite.config.ts for userscript builds.
 *
 * @module tooling/vite/presets/userscript
 */

import type { UserConfig } from 'vite';

export const userscriptPreset: UserConfig = {
  build: {
    target: 'es2023',
    minify: false,
    // Greasy Fork rule: scripts must not be minified/obfuscated.
    outDir: 'dist',
    emptyOutDir: true,
    write: true,
  },
};
