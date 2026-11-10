// SPDX-License-Identifier: MIT

import { expect, test } from '@playwright/test';

import {
  DEFAULT_SETTINGS,
  injectUserscript,
  installYTMock,
  MOCK_WATCH_URL,
  setupMockPageRoute,
} from '../fixtures/test-utils';

type AdoptionProbe = {
  scheduled: boolean;
  stopDone: boolean;
  stopError: string | null;
  connectedAtHandoff: boolean;
  activeObservers: Set<ResizeObserver>;
  activeKeydown: Set<EventListenerOrEventListenerObject>;
  activeFullscreen: Set<EventListenerOrEventListenerObject>;
};

function installAdoptionProbe(): void {
  const probe: AdoptionProbe = {
    scheduled: false,
    stopDone: false,
    stopError: null,
    connectedAtHandoff: false,
    activeObservers: new Set(),
    activeKeydown: new Set(),
    activeFullscreen: new Set(),
  };
  (window as unknown as { __overlayAdoptionProbe: AdoptionProbe }).__overlayAdoptionProbe = probe;

  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    override observe(target: Element, options?: ResizeObserverOptions): void {
      super.observe(target, options);
      probe.activeObservers.add(this);
    }

    override disconnect(): void {
      super.disconnect();
      probe.activeObservers.delete(this);
    }
  };

  const add = document.addEventListener;
  const remove = document.removeEventListener;
  document.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    Reflect.apply(add, document, [type, listener, options]);
    if (!listener || !document.querySelector('#yt-live-chat-overlay')?.isConnected) return;
    if (type === 'fullscreenchange') probe.activeFullscreen.add(listener);
    if (type !== 'keydown') return;
    probe.activeKeydown.add(listener);
    if (probe.scheduled) return;
    // Overlay.create has installed its last resource, but the awaiting runtime
    // has not yet resumed. The signal was live throughout the actual create.
    probe.scheduled = true;
    probe.connectedAtHandoff = true;
    queueMicrotask(() => {
      const handle = window.__ytChatOverlay;
      if (!handle) {
        probe.stopError = 'App handle was not exposed after disabled startup';
        probe.stopDone = true;
        return;
      }
      void Promise.resolve(handle.stop()).then(
        () => {
          probe.stopDone = true;
        },
        (error: unknown) => {
          probe.stopError = String(error);
          probe.stopDone = true;
        }
      );
    });
  } as typeof document.addEventListener;
  document.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void {
    Reflect.apply(remove, document, [type, listener, options]);
    if (!listener) return;
    if (type === 'keydown') probe.activeKeydown.delete(listener);
    if (type === 'fullscreenchange') probe.activeFullscreen.delete(listener);
  } as typeof document.removeEventListener;
}

test('exposed App stop retires an overlay before runtime adoption', async ({ page }) => {
  await setupMockPageRoute(page);
  await page.addInitScript(installYTMock, {
    defaults: { ...DEFAULT_SETTINGS, enabled: false },
    platform: 'userscript' as const,
  });
  await page.addInitScript(installAdoptionProbe);
  await injectUserscript(page);
  await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ytChatOverlay);
  expect(await page.locator('#yt-live-chat-overlay').count()).toBe(0);

  try {
    await page.evaluate(async () => {
      const handle = window.__ytChatOverlay;
      if (!handle) throw new Error('App handle missing');
      handle.applySettings({ enabled: true });
      await handle.restartRuntime();
    });
    await page.waitForFunction(
      () =>
        (window as unknown as { __overlayAdoptionProbe: AdoptionProbe }).__overlayAdoptionProbe
          .stopDone
    );
    const observed = await page.evaluate(async () => {
      const probe = (window as unknown as { __overlayAdoptionProbe: AdoptionProbe })
        .__overlayAdoptionProbe;
      await window.__ytChatOverlay?.stop();
      const reachedWindow: boolean[] = [];
      const onKeydown = (): void => {
        reachedWindow.push(true);
      };
      window.addEventListener('keydown', onKeydown);
      const keys = [true, false].map((ctrlKey) => {
        const event = new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          ctrlKey,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(event);
        return { defaultPrevented: event.defaultPrevented };
      });
      window.removeEventListener('keydown', onKeydown);
      return {
        scheduled: probe.scheduled,
        connectedAtHandoff: probe.connectedAtHandoff,
        stopError: probe.stopError,
        overlayCount: document.querySelectorAll('#yt-live-chat-overlay').length,
        observers: probe.activeObservers.size,
        keydown: probe.activeKeydown.size,
        fullscreen: probe.activeFullscreen.size,
        keys,
        reachedWindow: reachedWindow.length,
      };
    });
    expect(observed).toEqual({
      scheduled: true,
      connectedAtHandoff: true,
      stopError: null,
      overlayCount: 0,
      observers: 0,
      keydown: 0,
      fullscreen: 0,
      keys: [{ defaultPrevented: false }, { defaultPrevented: false }],
      reachedWindow: 2,
    });
  } finally {
    // Baseline failures remain isolated to this page and its real listeners.
    await page.close();
  }
});
