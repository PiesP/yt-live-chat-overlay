import { type ExtensionBrowser } from './extension-target.ts';
import { BIDI_LICENSE_BANNER } from '../bidi-license.ts';
import { createExtensionIifeConfig } from './extension-iife.ts';

export function createExtensionPageConfig(browser: ExtensionBrowser) {
  return createExtensionIifeConfig(browser, {
    banner: BIDI_LICENSE_BANNER,
    entry: 'extension/page-script.ts',
    fileName: 'page-script.js',
    name: 'YtChatOverlayPage',
    target: 'page script',
  });
}
