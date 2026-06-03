/**
 * Vite Configuration for Firefox MV3 Extension Build.
 *
 * Same multi-entry build as Chrome, but uses Firefox-specific manifest
 * with browser_specific_settings and the `menus` permission.
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
      emptyOutDir: true,

      rollupOptions: {
        input: {
          'background': resolve(REPO_ROOT, 'extension/background.ts'),
          'content-script': resolve(REPO_ROOT, 'extension/content-script.ts'),
          'workers/renderer-worker': resolve(REPO_ROOT, 'src/core/renderer-worker.ts'),
          'workers/renderer-worker-webgl2': resolve(REPO_ROOT, 'src/core/renderer-worker-webgl2.ts'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name.startsWith('workers/')) {
              return '[name].js';
            }
            return '[name].js';
          },
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },

    define: {
      __DEV__: JSON.stringify(false),
      __VERSION__: JSON.stringify(process.env.BUILD_VERSION || '0.36.0'),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },

    logLevel: 'warn',
  };
});
