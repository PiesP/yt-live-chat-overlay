import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import monkeyPlugin from 'vite-plugin-monkey';
import { basePreset } from '../presets/base.ts';
import { userscriptPreset } from '../presets/userscript.ts';

interface PackageMeta {
  author: string;
  description: string;
  homepage: string;
  license: string;
  version: string;
}

const root = resolve(import.meta.dirname, '..', '..', '..');
const packageMeta = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageMeta;

export function createUserscriptConfig({ mode }: ConfigEnv): UserConfig {
  const isDev = mode === 'development';
  const baseVersion = process.env.BUILD_VERSION ?? packageMeta.version;
  const version = isDev ? `${baseVersion}-dev` : baseVersion;
  const outputFileName = isDev
    ? 'yt-live-chat-overlay.dev.user.js'
    : 'yt-live-chat-overlay.user.js';

  return mergeConfig(mergeConfig(basePreset, userscriptPreset), {
    plugins: [
      monkeyPlugin({
        entry: resolve(root, 'src/main.ts'),
        userscript: {
          name: `YouTube Live Chat Overlay${isDev ? ' (dev)' : ''}`,
          version: baseVersion,
          description: packageMeta.description,
          author: packageMeta.author,
          match: ['https://www.youtube.com/*'],
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
          homepage: packageMeta.homepage,
          supportURL: `${packageMeta.homepage}/issues`,
          license: packageMeta.license,
          namespace: packageMeta.homepage.replace(/\/[^/]+$/, ''),
          downloadURL: `https://github.com/PiesP/yt-live-chat-overlay/releases/download/v${baseVersion}/yt-live-chat-overlay.user.js`,
          updateURL:
            'https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.meta.js',
        },
        build: {
          fileName: outputFileName,
          metaFileName: isDev ? false : 'yt-live-chat-overlay.meta.js',
        },
        server: {
          open: false,
        },
      }),
    ],
    build: {
      sourcemap: isDev ? 'inline' : false,
    },
    define: {
      __DEV__: JSON.stringify(isDev),
      __VERSION__: JSON.stringify(version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  }) as UserConfig;
}
