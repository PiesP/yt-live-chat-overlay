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
import { defineConfig, type UserConfigFn } from 'vite';
import pkg from './package.json';

export function createContentScriptConfig(outDir: string): UserConfigFn {
  const repoRoot = process.cwd();

  return defineConfig(() => {
    return {
      root: repoRoot,

      resolve: {
        tsconfigPaths: true,
      },

      build: {
        target: 'es2023',
        minify: false,
        sourcemap: false,
        outDir,
        emptyOutDir: false, // Don't clear — background/workers already built

        lib: {
          entry: resolve(repoRoot, 'extension/content-script.ts'),
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

      logLevel: 'warn' as const,
    };
  });
}
