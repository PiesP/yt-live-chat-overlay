import type { OverlaySettings } from '@app-types';

/**
 * Global type definitions for build constants and window extensions
 */

interface YtChatOverlayDebugHandle {
  start(): Promise<void>;
  stop(): void;
  getSettings(): Readonly<OverlaySettings>;
  applySettings(partial: Partial<OverlaySettings>): void;
  resetSettings(): void;
}

declare global {
  /** Build-time development flag injected by Vite. */
  const __DEV__: boolean;
  /** Semantic version string injected at build time. */
  const __VERSION__: string;
  /** Build timestamp injected at build time. */
  const __BUILD_TIME__: string;

  interface Window {
    /** Debug handle exposed by the overlay script (available in DevTools). */
    __ytChatOverlay: YtChatOverlayDebugHandle | undefined;
    /** YouTube initial page data (available on watch pages). */
    ytInitialData?: Record<string, unknown>;
    /** YouTube page configuration object (available on YouTube pages). */
    ytcfg?: { data_?: Record<string, unknown> };
  }
}
