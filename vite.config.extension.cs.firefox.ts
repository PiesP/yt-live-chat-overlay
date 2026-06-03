/**
 * Vite Configuration for Firefox MV3 Extension — Content Script (IIFE format).
 *
 * Same as vite.config.extension.cs.ts but outputs to dist-extension-firefox/.
 *
 * Content scripts injected into the page's MAIN world cannot use ES module
 * import/export syntax (they load as classic <script> elements, not modules).
 *
 * Usage: pnpm build:extension:firefox
 */

import { resolve } from 'node:path';
import { defineConfig, type UserConfig } from 'vite';

const REPO_ROOT = process.cwd();
const OUT_DIR = resolve(REPO_ROOT, 'dist-extension-firefox');

export default defineConfig((): UserConfig => {
  return {
    root: REPO_ROOT,

    resolve: {
      alias: {
        '@core': resolve(REPO_ROOT, 'src/core'),
        '@shared': resolve(REPO_ROOT, 'src/shared'),
        '@app-types': resolve(REPO_ROOT, 'src/types/index.ts'),
        '@platform': resolve(REPO_ROOT, 'src/platform'),
      },
    },

    build: {
      target: 'esnext',
      minify: false,
      sourcemap: false,
      outDir: OUT_DIR,
      emptyOutDir: false,

      lib: {
        entry: resolve(REPO_ROOT, 'extension/content-script.ts'),
        name: 'YtChatOverlay',
        formats: ['iife'],
        fileName: () => 'content-script.js',
      },

      rollupOptions: {
        output: {
          // IIFE format via build.lib — no chunks needed (codeSplitting is false)
        },
      },
    },

    define: {
      __DEV__: JSON.stringify(false),
      __VERSION__: JSON.stringify(process.env.BUILD_VERSION || '0.36.0'),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      'import.meta': JSON.stringify({}),
    },

    logLevel: 'warn',
  };
});
