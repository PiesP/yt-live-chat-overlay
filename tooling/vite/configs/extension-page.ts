import { type ExtensionBrowser } from './extension-target.ts';
import { createExtensionIifeConfig } from './extension-iife.ts';

export function createExtensionPageConfig(browser: ExtensionBrowser) {
  return createExtensionIifeConfig(browser, {
    entry: 'extension/page-script.ts',
    fileName: 'page-script.js',
    name: 'YtChatOverlayPage',
    target: 'page script',
  });
}
