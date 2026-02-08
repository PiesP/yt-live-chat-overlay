/**
 * Vite Configuration for YouTube Live Chat Overlay Userscript
 *
 * This configuration handles:
 * - TypeScript bundling
 * - Userscript metadata generation
 * - Single file bundle output
 *
 * Build modes:
 *   pnpm build      - Production build (runs `pnpm quality` via prebuild)
 *   pnpm build:dev  - Development build
 */

import { resolve } from 'node:path';
import { defineConfig, type UserConfig } from 'vite';
import { userscriptHeaderPlugin } from './tooling/userscript-header';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = process.cwd();
const OUTPUT_FILE_NAMES = {
  dev: 'yt-live-chat-overlay.dev.user.js',
  prod: 'yt-live-chat-overlay.user.js',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Vite Configuration
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig(({ mode }): UserConfig => {
  const isDev = mode === 'development';
  const version = isDev ? '0.2.0-dev' : '0.2.0';
  const buildTime = new Date().toISOString();
  const entryFile = resolve(REPO_ROOT, './src/main.ts');
  const outputFileName = isDev ? OUTPUT_FILE_NAMES.dev : OUTPUT_FILE_NAMES.prod;

  return {
    plugins: [userscriptHeaderPlugin(mode)],

    root: REPO_ROOT,

    resolve: {
      alias: {
        '@': resolve(REPO_ROOT, 'src'),
        '@core': resolve(REPO_ROOT, 'src/core'),
        '@app-types': resolve(REPO_ROOT, 'src/types/index.ts'),
      },
    },

    build: {
      target: 'esnext',
      // Greasy Fork rule: scripts must not be minified/obfuscated.
      minify: false,
      sourcemap: isDev ? 'inline' : false,
      outDir: 'dist',
      emptyOutDir: true,
      write: true,

      lib: {
        entry: entryFile,
        name: 'YtLiveChatOverlay',
        formats: ['iife'],
        fileName: () => outputFileName.replace('.user.js', ''),
      },

      rollupOptions: {
        output: {
          entryFileNames: outputFileName,
          inlineDynamicImports: true,
          // This userscript bundle is consumed as a single IIFE
          exports: 'none',
        },
      },
    },

    define: {
      __DEV__: JSON.stringify(isDev),
      __VERSION__: JSON.stringify(version),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },

    logLevel: 'warn',
  };
});
