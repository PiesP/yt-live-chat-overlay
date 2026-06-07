/**
 * Vite Configuration for Chrome MV3 Extension — Content Script (IIFE format).
 *
 * Content scripts injected into the page's MAIN world cannot use ES module
 * import/export syntax (they load as classic <script> elements, not modules).
 * This config builds only the content-script as a self-contained IIFE bundle.
 *
 * Background and workers are built separately (see vite.config.extension.ts).
 *
 * Usage: pnpm build:extension:cs
 */

import { resolve } from 'node:path';
import { defineConfig, type UserConfig } from 'vite';
import pkg from './package.json';

const REPO_ROOT = process.cwd();
const OUT_DIR = resolve(REPO_ROOT, 'dist-extension');

export default defineConfig((): UserConfig => {
  return {
    root: REPO_ROOT,

    resolve: {
      tsconfigPaths: true,
    },

    build: {
      target: 'esnext',
      minify: false,
      sourcemap: false,
      outDir: OUT_DIR,
      emptyOutDir: false, // Don't clear — background/workers already built

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
      __VERSION__: JSON.stringify(process.env.BUILD_VERSION || pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      // Suppress import.meta warning in IIFE build — ChromeExtensionWorkerFactory
      // is selected by getWorkerFactory() in extension context, so ViteWorkerFactory
      // (which uses import.meta.url) never executes at runtime.
      'import.meta': JSON.stringify({}),
    },

    logLevel: 'warn',
  };
});
