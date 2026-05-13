/**
 * Vite Configuration for YouTube Live Chat Overlay Userscript
 *
 * This configuration handles:
 * - TypeScript bundling
 * - Userscript metadata generation (via vite-plugin-monkey)
 * - Single file bundle output
 * - Dev server with HMR for rapid userscript development
 *
 * Build modes:
 *   pnpm dev        - Development build with watch mode (auto-rebuild on change)
 *   pnpm build:dev  - Development build (single run)
 *   pnpm build      - Production build (runs `pnpm quality` via prebuild)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type UserConfig } from 'vite';
import monkeyPlugin from 'vite-plugin-monkey';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = process.cwd();
const REPOSITORY_URL = 'https://github.com/PiesP/yt-live-chat-overlay';
const OUTPUT_FILE_NAMES = {
  dev: 'yt-live-chat-overlay.dev.user.js',
  prod: 'yt-live-chat-overlay.user.js',
} as const;

const USERSCRIPT_MATCH_PATTERNS = ['https://www.youtube.com/*'] as const;
const USERSCRIPT_ENTRY = resolve(REPO_ROOT, './src/main.ts');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getVersion(): string {
  const buildVersion = process.env.BUILD_VERSION;
  if (buildVersion) {
    return buildVersion;
  }
  const packageJsonPath = resolve(REPO_ROOT, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };
  return packageJson.version;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite Configuration
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig(({ mode }): UserConfig => {
  const isDev = mode === 'development';
  const baseVersion = getVersion();
  const version = isDev ? `${baseVersion}-dev` : baseVersion;
  const outputFileName = isDev ? OUTPUT_FILE_NAMES.dev : OUTPUT_FILE_NAMES.prod;

  return {
    plugins: [
      monkeyPlugin({
        entry: USERSCRIPT_ENTRY,
        userscript: {
          name: `YouTube Live Chat Overlay${isDev ? ' (dev)' : ''}`,
          version: baseVersion,
          description:
            'Displays YouTube live chat in Nico-nico style flowing overlay (100% local, no data collection)',
          author: 'PiesP',
          match: [...USERSCRIPT_MATCH_PATTERNS],
          grant: ['GM_deleteValue', 'GM_getValue', 'GM_registerMenuCommand', 'GM_setValue'],
          'run-at': 'document-end',
          icon: 'https://www.youtube.com/favicon.ico',
          homepage: REPOSITORY_URL,
          supportURL: `${REPOSITORY_URL}/issues`,
          license: 'MIT',
          namespace: 'https://github.com/PiesP',
        },
        build: {
          fileName: outputFileName,
          metaFileName: false,
        },
        server: {
          // HMR dev server — injects a proxy script into the page
          // Requires Disable-CSP browser extension for YouTube's CSP
          open: false,
        },
      }),
    ],

    root: REPO_ROOT,

    resolve: {
      alias: {
        '@core': resolve(REPO_ROOT, 'src/core'),
        '@app-types': resolve(REPO_ROOT, 'src/types/index.ts'),
      },
    },

    build: {
      target: 'esnext',
      // Greasy Fork rule: scripts must not be minified/obfuscated.
      // vite-plugin-monkey also enforces this by default.
      minify: false,
      sourcemap: isDev ? 'inline' : false,
      outDir: 'dist',
      emptyOutDir: true,
      write: true,

      rollupOptions: {
        output: {
          exports: 'none',
        },
      },
    },

    define: {
      __DEV__: JSON.stringify(isDev),
      __VERSION__: JSON.stringify(version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },

    logLevel: 'warn',
  };
});
