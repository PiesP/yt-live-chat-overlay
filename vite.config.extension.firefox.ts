/**
 * Vite Configuration for Firefox MV3 Extension — Background + Workers (ES modules).
 *
 * Usage: pnpm build:extension:firefox:sw
 */

import { createExtensionConfig } from './vite.config.extension.shared';

export default createExtensionConfig('dist-extension-firefox');
