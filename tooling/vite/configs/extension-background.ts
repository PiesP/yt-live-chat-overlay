import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import pkg from '../../../package.json';
import { copyExtensionAssetsPlugin } from '../plugins/copy-extension-assets';
import { basePreset } from '../presets/base';
import { extensionSwPreset } from '../presets/extension-sw';
import { type ExtensionBrowser, extensionTarget } from './extension-target';

export function createExtensionBackgroundConfig(browser: ExtensionBrowser) {
  const target = extensionTarget(browser);

  return defineConfig(({ mode }) => {
    const isDev = mode === 'development';

    return mergeConfig(mergeConfig(basePreset, extensionSwPreset), {
      plugins: [
        copyExtensionAssetsPlugin({
          root: target.root,
          outDir: resolve(target.root, target.outDir),
          manifestFile: target.manifestFile,
        }),
      ],
      build: {
        minify: !isDev,
        sourcemap: isDev,
        outDir: target.outDir,
        rollupOptions: {
          input: {
            background: resolve(target.root, 'extension/background.ts'),
            'workers/renderer': resolve(target.root, 'src/renderer/worker/renderer.ts'),
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
          },
        },
      },
      define: {
        __VERSION__: JSON.stringify(process.env.BUILD_VERSION ?? pkg.version),
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      },
    }) as UserConfig;
  });
}
