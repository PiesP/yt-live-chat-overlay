/**
 * Base Vite preset shared across all yt-live-chat-overlay build targets.
 *
 * Applied by every config via mergeConfig. Contains settings that are
 * identical regardless of build target (userscript, extension SW, extension CS).
 *
 * @module tooling/vite/presets/base
 */

import type { UserConfig } from 'vite';

export function createBasePreset(): UserConfig {
  return {
    root: process.cwd(),

    resolve: {
      tsconfigPaths: true,
    },

    define: {
      __DEV__: 'process.env.NODE_ENV === "development"',
      __VERSION__: '""',
      __BUILD_TIME__: '""',
    },

    logLevel: 'warn',
  };
}

/** Base preset applied to all configs. Override individual fields as needed. */
export const basePreset: UserConfig = createBasePreset();
