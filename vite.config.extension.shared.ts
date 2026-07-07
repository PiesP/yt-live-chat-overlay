/**
 * Shared extension Vite config factory for Chrome and Firefox MV3 extensions.
 *
 * Both configs differ only in output directory. This factory captures the
 * 95% shared configuration (rollup inputs, output format, define globals)
 * and composes presets via mergeConfig.
 *
 * Used by:
 *   - vite.config.extension.ts (Chrome → dist-extension/)
 *   - vite.config.extension.firefox.ts (Firefox → dist-extension-firefox/)
 */

import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import pkg from './package.json';
import { basePreset } from './tooling/vite/presets/base';
import { extensionSwPreset } from './tooling/vite/presets/extension-sw';

export function createExtensionConfig(outDir: string) {
  const repoRoot = process.cwd();

  return defineConfig(({ mode }) => {
    const isDev = mode === 'development';

    return mergeConfig(mergeConfig(basePreset, extensionSwPreset), {
      build: {
        minify: !isDev,
        sourcemap: isDev,
        outDir,
        rollupOptions: {
          input: {
            background: resolve(repoRoot, 'extension/background.ts'),
            'workers/renderer': resolve(repoRoot, 'src/renderer/worker/renderer.ts'),
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
          },
        },
      },

      define: {
        __VERSION__: JSON.stringify(process.env.BUILD_VERSION || pkg.version),
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      },
    }) as UserConfig;
  });
}
