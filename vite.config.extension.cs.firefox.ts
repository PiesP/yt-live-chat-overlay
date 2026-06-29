/**
 * Vite Configuration for Firefox MV3 Extension — Content Script (IIFE format).
 *
 * Same as vite.config.extension.cs.ts but outputs to dist-extension-firefox/.
 *
 * Usage: pnpm build:extension:firefox
 */

import { createContentScriptConfig } from './vite.config.extension.cs.shared';

export default createContentScriptConfig('dist-extension-firefox');
