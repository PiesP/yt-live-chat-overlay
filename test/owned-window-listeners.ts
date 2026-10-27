// SPDX-License-Identifier: MIT

import { vi } from 'vite-plus/test';

/** Retain only listeners registered by a side-effect module during this test's import. */
export class OwnedWindowListeners {
  private readonly listeners: Array<{
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  }> = [];

  get size(): number {
    return this.listeners.length;
  }

  async load(loadModule: () => Promise<unknown>): Promise<void> {
    const nativeAdd = window.addEventListener.bind(window);
    const spy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        nativeAdd(type, listener, options);
        this.listeners.push({
          type,
          listener,
          capture: typeof options === 'boolean' ? options : (options?.capture ?? false),
        });
      });
    try {
      await loadModule();
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      spy.mockRestore();
    }
  }

  dispose(): void {
    for (const { type, listener, capture } of this.listeners.splice(0)) {
      window.removeEventListener(type, listener, capture);
    }
  }
}
