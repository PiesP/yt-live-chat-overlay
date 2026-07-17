/**
 * Vite Configuration for Firefox MV3 Extension — Page Script (IIFE format).
 *
 * Builds the MAIN-world page script that is injected as a <script> tag
 * by the ISOLATED-world content script.
 *
 * Usage: vite build --config vite.config.extension.page.firefox.ts
 */

import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import pkg from './package.json';
import { basePreset } from './tooling/vite/presets/base';
import { extensionCsPreset } from './tooling/vite/presets/extension-cs';

export default defineConfig(
  () =>
    mergeConfig(mergeConfig(basePreset, extensionCsPreset), {
      build: {
        outDir: 'dist-extension-firefox',

        lib: {
          entry: resolve(process.cwd(), 'extension/page-script.ts'),
          name: 'YtChatOverlayPage',
          formats: ['iife'],
          fileName: () => 'page-script.js',
        },
      },

      define: {
        __VERSION__: JSON.stringify(process.env.BUILD_VERSION || pkg.version),
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      },
    }) as UserConfig
);
