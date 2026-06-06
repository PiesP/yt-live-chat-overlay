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
  return getPackageMeta().version;
}

interface PackageMeta {
  version: string;
  author: string;
  license: string;
  description: string;
  homepage: string;
  repositoryUrl: string;
}

let _pkgMeta: PackageMeta | null = null;
function getPackageMeta(): PackageMeta {
  if (_pkgMeta) return _pkgMeta;
  const packageJsonPath = resolve(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    version: string;
    author: string;
    license: string;
    description: string;
    homepage: string;
    repository?: { url: string };
  };
  _pkgMeta = {
    version: pkg.version,
    author: pkg.author,
    license: pkg.license,
    description: pkg.description,
    homepage: pkg.homepage,
    repositoryUrl:
      typeof pkg.repository === 'object' && pkg.repository?.url
        ? pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
        : pkg.homepage,
  };
  return _pkgMeta;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite Configuration
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig(({ mode }): UserConfig => {
  const isDev = mode === 'development';
  const baseVersion = getVersion();
  const version = isDev ? `${baseVersion}-dev` : baseVersion;
  const outputFileName = isDev ? OUTPUT_FILE_NAMES.dev : OUTPUT_FILE_NAMES.prod;
  const pkg = getPackageMeta();

  return {
    plugins: [
      monkeyPlugin({
        entry: USERSCRIPT_ENTRY,
        userscript: {
          name: `YouTube Live Chat Overlay${isDev ? ' (dev)' : ''}`,
          version: baseVersion,
          description: pkg.description,
          author: pkg.author,
          match: [...USERSCRIPT_MATCH_PATTERNS],
          grant: [
            'GM_addValueChangeListener',
            'GM_deleteValue',
            'GM_getValue',
            'GM_registerMenuCommand',
            'GM_removeValueChangeListener',
            'GM_setValue',
          ],
          'run-at': 'document-end',
          icon: 'https://www.youtube.com/favicon.ico',
          homepage: pkg.homepage,
          supportURL: `${pkg.homepage}/issues`,
          license: pkg.license,
          namespace: pkg.homepage.replace(/\/[^/]+$/, ''),
          downloadURL:
            'https://cdn.jsdelivr.net/gh/PiesP/yt-live-chat-overlay@release/dist/yt-live-chat-overlay.user.js',
          updateURL:
            'https://cdn.jsdelivr.net/gh/PiesP/yt-live-chat-overlay@release/dist/yt-live-chat-overlay.meta.js',
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
      tsconfigPaths: true,
    },

    build: {
      target: 'esnext',
      // Greasy Fork rule: scripts must not be minified/obfuscated.
      minify: false,
      sourcemap: isDev ? 'inline' : false,
      outDir: 'dist',
      emptyOutDir: true,
      write: true,
    },

    define: {
      __DEV__: JSON.stringify(isDev),
      __VERSION__: JSON.stringify(version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },

    logLevel: 'warn',
  };
});
