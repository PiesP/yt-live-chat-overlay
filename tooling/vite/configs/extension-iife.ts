import { resolve } from 'node:path';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import pkg from '../../../package.json' with { type: 'json' };
import { enforceIifePlugin } from '../plugins/enforce-iife.ts';
import { basePreset } from '../presets/base.ts';
import { extensionCsPreset } from '../presets/extension-cs.ts';
import { type ExtensionBrowser, extensionTarget } from './extension-target.ts';

export interface ExtensionIifeConfigOptions {
  entry: string;
  fileName: string;
  name: string;
  target: string;
}

export function createExtensionIifeConfig(
  browser: ExtensionBrowser,
  options: ExtensionIifeConfigOptions
) {
  const target = extensionTarget(browser);

  return defineConfig(
    () =>
      mergeConfig(mergeConfig(basePreset, extensionCsPreset), {
        plugins: [enforceIifePlugin(`${browser} ${options.target}`)],
        build: {
          outDir: target.outDir,
          lib: {
            entry: resolve(target.root, options.entry),
            name: options.name,
            formats: ['iife'],
            fileName: () => options.fileName,
          },
        },
        define: {
          __VERSION__: JSON.stringify(process.env.BUILD_VERSION ?? pkg.version),
          __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        },
      }) as UserConfig
  );
}
