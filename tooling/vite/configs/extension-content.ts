import { type ExtensionBrowser } from './extension-target.ts';
import { createExtensionIifeConfig } from './extension-iife.ts';

export function createExtensionContentConfig(browser: ExtensionBrowser) {
  return createExtensionIifeConfig(browser, {
    entry: 'extension/content-script.ts',
    fileName: 'content-script.js',
    name: 'YtChatOverlay',
    target: 'content script',
  });
}
