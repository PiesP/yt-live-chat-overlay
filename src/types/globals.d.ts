/**
 * Global type definitions for build constants and window extensions
 */

declare const __DEV__: boolean;
declare const __VERSION__: string;
declare const __BUILD_TIME__: string;

// Augment the global Window interface so debugger access is typed
interface Window {
  /** Debug handle exposed by the overlay script (available in DevTools) */
  __ytChatOverlay?: unknown;
}
