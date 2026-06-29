/**
 * Vite Configuration for Chrome MV3 Extension — Content Script (IIFE format).
 *
 * Content scripts injected into the page's MAIN world cannot use ES module
 * import/export syntax (they load as classic <script> elements, not modules).
 * This config builds only the content-script as a self-contained IIFE bundle.
 *
 * Background and workers are built separately (see vite.config.extension.ts).
 *
 * Usage: pnpm build:extension:cs
 */

import { createContentScriptConfig } from './vite.config.extension.cs.shared';

export default createContentScriptConfig('dist-extension');
