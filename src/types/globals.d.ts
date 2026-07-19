// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';

/**
 * Global type definitions for build constants, window extensions,
 * and Tampermonkey GM storage APIs.
 */

interface YtChatOverlayDebugHandle {
  start(): Promise<void>;
  stop(): void;
  restartRuntime(): Promise<void>;
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
    GM_listValues?: () => string[];
    GM_openInTab?: (url: string) => void;
    GM_cookie?: {
      list(): Array<{ name: string; value: string }>;
      set(cookie: { name: string; value: string }): void;
      delete(name: string): void;
    };
    /** YouTube initial page data (available on watch pages). */
    ytInitialData?: Record<string, unknown>;
    /** YouTube page configuration object (available on YouTube pages). */
    ytcfg?: { data_?: Record<string, unknown> };
  }

  /**
   * Minimal type declarations for Tampermonkey GM storage APIs.
   * Full types are provided by vite-plugin-monkey/client when grant is set,
   * but we need these declarations available at all times for the storage adapter.
   */
  function GM_setValue(key: string, value: string): void;
  function GM_getValue(key: string, defaultValue?: string): string | undefined;
  function GM_deleteValue(key: string): void;
  function GM_registerMenuCommand(name: string, fn: () => void): number;
  /**
   * Listen for changes to a GM storage key. Returns a listener ID for removal.
   * Fires on all tabs, including the tab that made the change.
   */
  function GM_addValueChangeListener(
    key: string,
    callback: (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void
  ): number;
  function GM_removeValueChangeListener(listenerId: number): void;
}
