/**
 * Minimal type declarations for Tampermonkey GM storage APIs.
 * Full types are provided by vite-plugin-monkey/client when grant is set,
 * but we need these declarations available at all times for the storage adapter.
 */
declare function GM_setValue(key: string, value: string): void;
declare function GM_getValue(key: string, defaultValue?: string): string | undefined;
declare function GM_deleteValue(key: string): void;
declare function GM_registerMenuCommand(name: string, fn: () => void): number;
/**
 * Listen for changes to a GM storage key. Returns a listener ID for removal.
 * Fires on all tabs, including the tab that made the change.
 */
declare function GM_addValueChangeListener(
  key: string,
  callback: (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void
): number;
declare function GM_removeValueChangeListener(listenerId: number): void;
