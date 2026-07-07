/**
 * Shared content script Vite config factory for Chrome and Firefox MV3 extensions.
 *
 * Content scripts injected into the page's MAIN world cannot use ES module
 * import/export syntax (they load as classic <script> elements, not modules).
 * This factory builds the content script as a self-contained IIFE bundle.
 *
 * Used by:
 *   - vite.config.extension.cs.ts (Chrome → dist-extension/)
 *   - vite.config.extension.cs.firefox.ts (Firefox → dist-extension-firefox/)
 */

import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import pkg from './package.json';
import { basePreset } from './tooling/vite/presets/base';
import { extensionCsPreset } from './tooling/vite/presets/extension-cs';

export function createContentScriptConfig(outDir: string) {
  const repoRoot = process.cwd();

  return defineConfig(
    () =>
      mergeConfig(mergeConfig(basePreset, extensionCsPreset), {
        build: {
          outDir,

          lib: {
            entry: resolve(repoRoot, 'extension/content-script.ts'),
            name: 'YtChatOverlay',
            formats: ['iife'],
            fileName: () => 'content-script.js',
          },
        },

        define: {
          __VERSION__: JSON.stringify(process.env.BUILD_VERSION || pkg.version),
          __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        },
      }) as UserConfig
  );
}
