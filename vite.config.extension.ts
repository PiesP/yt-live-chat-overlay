/**
 * Vite Configuration for Chrome MV3 Extension — Background + Workers (ES modules).
 *
 * Usage: pnpm build:extension:sw
 */

import { createExtensionConfig } from './vite.config.extension.shared';

export default createExtensionConfig('dist-extension');
