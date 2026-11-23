import { DISTRIBUTION_NOTICE_BANNER } from '../distribution-notices.ts';
import { createExtensionIifeConfig } from './extension-iife.ts';
import type { ExtensionBrowser } from './extension-target.ts';

export function createExtensionPageConfig(browser: ExtensionBrowser) {
  return createExtensionIifeConfig(browser, {
    banner: DISTRIBUTION_NOTICE_BANNER,
    entry: 'extension/page-script.ts',
    fileName: 'page-script.js',
    name: 'YtChatOverlayPage',
    target: 'page script',
  });
}
