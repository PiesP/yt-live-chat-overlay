/**
 * Vite plugin to inject userscript metadata header
 */

import type { Plugin } from 'vite';

interface UserscriptMeta {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly match: readonly string[];
  readonly grant: readonly string[];
  readonly runAt: string;
}

const PLUGIN_NAME = 'userscript-header';
const REPOSITORY_URL = 'https://github.com/PiesP/yt-live-chat-overlay';
const USERSCRIPT_ICON_URL = 'https://www.youtube.com/favicon.ico';
const USERSCRIPT_MATCH_PATTERNS = ['https://www.youtube.com/*'] as const;
const USERSCRIPT_GRANTS = ['none'] as const;
const LEGAL_NOTICE = `/* LEGAL NOTICE:
 * This userscript operates ENTIRELY in the user's browser (100% local processing).
 * NO chat data is stored, transmitted, or processed externally.
 * Only user settings (font size, speed, etc.) are stored in localStorage.
 * This is NOT an official YouTube or Nico-nico product.
 * The script injects an overlay/settings control and fetches chat directly in-browser without relying on the visible chat panel.
 */`;

const formatDirective = (key: string, value: string): string =>
  `// @${key.padEnd(12)} ${value}`;

const createUserscriptMeta = (version: string, isDev: boolean): UserscriptMeta => ({
  name: `YouTube Live Chat Overlay${isDev ? ' (dev)' : ''}`,
  version,
  description:
    'Displays YouTube live chat in Nico-nico style flowing overlay (100% local, no data collection)',
  author: 'PiesP',
  match: USERSCRIPT_MATCH_PATTERNS,
  grant: USERSCRIPT_GRANTS,
  runAt: 'document-end',
});

const buildMetadataLines = (meta: UserscriptMeta): string[] => [
  formatDirective('name', meta.name),
  formatDirective('version', meta.version),
  formatDirective('description', meta.description),
  formatDirective('author', meta.author),
  ...meta.match.map((pattern) => formatDirective('match', pattern)),
  ...meta.grant.map((grant) => formatDirective('grant', grant)),
  formatDirective('run-at', meta.runAt),
  formatDirective('icon', USERSCRIPT_ICON_URL),
  formatDirective('homepage', REPOSITORY_URL),
  formatDirective('supportURL', `${REPOSITORY_URL}/issues`),
  formatDirective('license', 'MIT'),
  formatDirective('namespace', 'https://github.com/PiesP'),
];

const isUserscriptChunk = (fileName: string, chunk: { type: string }): boolean =>
  fileName.endsWith('.user.js') && chunk.type === 'chunk';

/**
 * Generate userscript metadata header
 */
function generateHeader(meta: UserscriptMeta): string {
  return [
    '// ==UserScript==',
    ...buildMetadataLines(meta),
    '// ==/UserScript==',
    '',
    LEGAL_NOTICE,
    '',
  ].join('\n');
}

/**
 * Vite plugin for userscript header injection
 */
export function userscriptHeaderPlugin(mode: string, version: string): Plugin {
  const meta = createUserscriptMeta(version, mode === 'development');

  return {
    name: PLUGIN_NAME,
    enforce: 'post',

    generateBundle(_, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (!isUserscriptChunk(fileName, chunk)) continue;

        chunk.code = `${generateHeader(meta)}${chunk.code}`;
      }
    },
  };
}
