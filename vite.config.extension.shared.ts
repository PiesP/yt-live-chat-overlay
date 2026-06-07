/**
 * Shared extension Vite config factory for Chrome and Firefox MV3 extensions.
 *
 * Both configs differ only in output directory. This factory captures the
 * 95% shared configuration (rollup inputs, output format, define globals).
 *
 * Used by:
 *   - vite.config.extension.ts (Chrome → dist-extension/)
 *   - vite.config.extension.firefox.ts (Firefox → dist-extension-firefox/)
 */

import { resolve } from 'node:path';
import { defineConfig, type UserConfig } from 'vite';
import pkg from './package.json';

export function createExtensionConfig(outDir: string): UserConfig {
  const repoRoot = process.cwd();

  return defineConfig({
    root: repoRoot,

    resolve: {
      tsconfigPaths: true,
    },

    build: {
      target: 'esnext',
      minify: false,
      sourcemap: false,
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,

      rollupOptions: {
        input: {
          'background': resolve(repoRoot, 'extension/background.ts'),
          'workers/renderer-worker': resolve(repoRoot, 'src/core/renderer-worker.ts'),
          'workers/renderer-worker-webgl2': resolve(repoRoot, 'src/core/renderer-worker-webgl2.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },

    define: {
      __DEV__: JSON.stringify(false),
      __VERSION__: JSON.stringify(process.env.BUILD_VERSION || pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },

    logLevel: 'warn',
  });
}
