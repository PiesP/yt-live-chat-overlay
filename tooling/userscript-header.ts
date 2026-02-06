/**
 * Vite plugin to inject userscript metadata header
 */

import type { Plugin } from 'vite';

interface UserscriptMeta {
  name: string;
  version: string;
  description: string;
  author: string;
  match: string[];
  grant: string[];
  runAt: string;
}

/**
 * Generate userscript metadata header
 */
function generateHeader(meta: UserscriptMeta, isDev: boolean): string {
  const lines = [
    '// ==UserScript==',
    `// @name         ${meta.name}${isDev ? ' (dev)' : ''}`,
    `// @version      ${meta.version}`,
    `// @description  ${meta.description}`,
    `// @author       ${meta.author}`,
    ...meta.match.map((pattern) => `// @match        ${pattern}`),
    ...meta.grant.map((perm) => `// @grant        ${perm}`),
    `// @run-at       ${meta.runAt}`,
    '// @icon         https://www.youtube.com/favicon.ico',
    '// @homepage     https://github.com/PiesP/yt-live-chat-overlay',
    '// @supportURL   https://github.com/PiesP/yt-live-chat-overlay/issues',
    '// @license      MIT',
    '// @namespace    https://github.com/PiesP',
    '// ==/UserScript==',
    '',
    '/* LEGAL NOTICE:',
    ' * This userscript operates ENTIRELY in the user\'s browser (100% local processing).',
    ' * NO chat data is stored, transmitted, or processed externally.',
    ' * Only user settings (font size, speed, etc.) are stored in localStorage.',
    ' * This is NOT an official YouTube or Nico-nico product.',
    ' * YouTube UI/content is NOT modified - only an overlay is added.',
    ' */',
    '',
  ];
  return lines.join('\n');
}

/**
 * Vite plugin for userscript header injection
 */
export function userscriptHeaderPlugin(mode: string): Plugin {
  const isDev = mode === 'development';

  const meta: UserscriptMeta = {
    name: 'YouTube Live Chat Overlay',
    version: isDev ? '0.1.0-dev' : '0.1.0',
    description:
      'Displays YouTube live chat in Nico-nico style flowing overlay (100% local, no data collection)',
    author: 'PiesP',
    match: ['https://www.youtube.com/*'],
    grant: ['none'],
    runAt: 'document-end',
  };

  return {
    name: 'userscript-header',
    enforce: 'post',

    generateBundle(_, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.user.js') && chunk.type === 'chunk') {
          const header = generateHeader(meta, isDev);
          chunk.code = header + chunk.code;
        }
      }
    },
  };
}
