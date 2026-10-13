import { createExtensionIifeConfig } from './extension-iife.ts';
import type { ExtensionBrowser } from './extension-target.ts';

export function createExtensionContentConfig(browser: ExtensionBrowser) {
  return createExtensionIifeConfig(browser, {
    entry: 'extension/content-script.ts',
    fileName: 'content-script.js',
    name: 'YtChatOverlay',
    target: 'content script',
  });
}
