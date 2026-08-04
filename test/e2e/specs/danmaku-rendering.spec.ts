// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Danmaku appearance on mock chat messages.
 *
 * Verifies that when the overlay initializes on a mock YouTube page,
 * the container and canvas elements are present and the app's debug
 * handle exposes settings correctly.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  setupOverlayPage,
  OVERLAY_ID,
  getSettings,
  applySettings,
  USERSCRIPT_PATH,
} from '../fixtures/test-utils';


test.describe('Danmaku Rendering', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
      );
    }
  });

  test('overlay container is present in DOM after initialization', async ({ page }) => {
    await setupOverlayPage(page);

    const overlay = page.locator(`#${OVERLAY_ID}`);
    await expect(overlay).toBeAttached({ timeout: 5000 });
  });

  test('canvas element exists inside overlay container', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached({ timeout: 5000 });

    // Canvas should have a non-zero size
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  test('debug handle is accessible after setup', async ({ page }) => {
    await setupOverlayPage(page);

    const hasHandle = await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const handle = w.__ytChatOverlay;
      return typeof handle === 'object' && handle !== null;
    });
    expect(hasHandle).toBe(true);
  });

  test('debug handle getSettings returns valid settings object', async ({ page }) => {
    await setupOverlayPage(page);

    const settings = await getSettings(page);
    expect(settings).toBeTruthy();
    expect(typeof settings.enabled).toBe('boolean');
    expect(typeof settings.fontSize).toBe('number');
    expect(typeof settings.opacity).toBe('number');
    expect(typeof settings.speedPxPerSec).toBe('number');
    expect(typeof settings.colors).toBe('object');
  });

  test('renders a real DOM chat message exactly once', async ({ page }) => {
    await setupOverlayPage(page);
    await applySettings(page, {
      showDebugOverlay: true,
      allowShortTextMessages: true,
    });

    const chatItems = page.locator('yt-live-chat-item-list-renderer #items');
    await expect(chatItems).toBeAttached();

    await page.evaluate(() => {
      const items = document.querySelector('yt-live-chat-item-list-renderer #items');
      if (!items) throw new Error('Mock live chat items container is missing');

      const appendMessage = (): void => {
        const renderer = document.createElement('yt-live-chat-text-message-renderer');
        renderer.id = 'e2e-message-1';

        const author = document.createElement('span');
        author.id = 'author-name';
        author.textContent = 'E2E Author';

        const message = document.createElement('span');
        message.id = 'message';
        message.textContent = 'Deterministic overlay rendering message';

        renderer.append(author, message);
        items.append(renderer);
      };

      appendMessage();
      appendMessage();
    });

    const receivedAndRendered = page.locator('#yt-chat-overlay-debug > div').first();
    await expect(receivedAndRendered).toHaveText('Rcvd: 1 | Rndr: 1');
  });

  test('renders the full height of cached Latin glyphs', async ({ page }) => {
    await setupOverlayPage(page, { platform: 'userscript' });
    await applySettings(page, {
      allowShortTextMessages: true,
      danmakuMode: 'top',
      showDebugOverlay: true,
      backgroundColors: { normal: '#00000000' },
      showAuthor: { normal: false },
      outline: { enabled: true, widthPx: 2, opacity: 0.7 },
    });

    await page.evaluate(() => {
      const items = document.querySelector('yt-live-chat-item-list-renderer #items');
      if (!items) throw new Error('Mock live chat items container is missing');

      const renderer = document.createElement('yt-live-chat-text-message-renderer');
      renderer.id = 'e2e-latin-height-message';
      const author = document.createElement('span');
      author.id = 'author-name';
      author.textContent = 'Latin Height Author';
      const message = document.createElement('span');
      message.id = 'message';
      message.textContent = 'HELLO';
      renderer.append(author, message);
      items.append(renderer);
    });

    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    const measureGlyphHeights = () =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d');
        if (!context) return null;

        const findInkHeight = (pixels: Uint8ClampedArray, width: number): number => {
          let minY = Number.POSITIVE_INFINITY;
          let maxY = Number.NEGATIVE_INFINITY;
          for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i]! <= 8) continue;
            const y = Math.floor((i - 3) / 4 / width);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
          return Number.isFinite(minY) ? maxY - minY + 1 : 0;
        };

        const renderedPixels = context.getImageData(
          0,
          0,
          element.width,
          Math.floor(element.height / 2)
        ).data;
        const renderedHeight = findInkHeight(renderedPixels, element.width);
        const renderedAlpha = renderedPixels.reduce(
          (total, value, index) => total + (index % 4 === 3 ? value : 0),
          0
        );
        if (renderedHeight === 0) return null;

        const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay as
          | { getSettings?: () => Record<string, unknown> }
          | undefined;
        const settings = handle?.getSettings?.();
        if (!settings) return null;

        const baseFontSize = Number(settings.fontSize);
        const fontWeight = String(settings.fontWeight);
        const fontFamily = String(settings.fontFamily);

        const reference = document.createElement('canvas');
        reference.width = 256;
        reference.height = 128;
        const referenceContext = reference.getContext('2d');
        if (!referenceContext) return null;
        referenceContext.font = `${fontWeight} ${baseFontSize}px ${fontFamily}`;
        referenceContext.textBaseline = 'top';
        referenceContext.lineWidth = 1.7;
        referenceContext.lineJoin = 'round';
        referenceContext.lineCap = 'round';
        referenceContext.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        referenceContext.fillStyle = '#ffffff';
        referenceContext.strokeText('HELLO', 8, 8);
        referenceContext.fillText('HELLO', 8, 8);
        const referencePixels = referenceContext.getImageData(
          0,
          0,
          reference.width,
          reference.height
        ).data;

        return {
          rendered: renderedHeight,
          renderedAlpha,
          reference: findInkHeight(referencePixels, reference.width),
          referenceAlpha: referencePixels.reduce(
            (total, value, index) => total + (index % 4 === 3 ? value : 0),
            0
          ),
        };
      });

    await expect.poll(measureGlyphHeights, { timeout: 5000 }).not.toBeNull();
    await expect
      .poll(
        async () => {
          const measurements = await measureGlyphHeights();
          if (!measurements || measurements.referenceAlpha === 0) return 0;
          return measurements.renderedAlpha / measurements.referenceAlpha;
        },
        { timeout: 5000 }
      )
      .toBeGreaterThanOrEqual(0.95);
    const glyphHeights = await measureGlyphHeights();

    expect(glyphHeights).not.toBeNull();
    expect(glyphHeights!.rendered).toBeGreaterThanOrEqual(glyphHeights!.reference - 1);
    expect(glyphHeights!.renderedAlpha / glyphHeights!.referenceAlpha).toBeGreaterThanOrEqual(
      0.95
    );
  });

  test('renders a user-selected solid translucent background on a regular message', async ({
    page,
  }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });

    await setupOverlayPage(page);
    await applySettings(page, {
      allowShortTextMessages: true,
      backgroundColors: { normal: '#FF000059' },
      danmakuMode: 'top',
      showDebugOverlay: true,
    });

    await page.evaluate(() => {
      const items = document.querySelector('yt-live-chat-item-list-renderer #items');
      if (!items) throw new Error('Mock live chat items container is missing');

      const renderer = document.createElement('yt-live-chat-text-message-renderer');
      renderer.id = 'e2e-background-message';
      const author = document.createElement('span');
      author.id = 'author-name';
      author.textContent = 'Background Author';
      const message = document.createElement('span');
      message.id = 'message';
      message.textContent = 'Solid translucent background verification';
      renderer.append(author, message);
      items.append(renderer);
    });

    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect
      .poll(
        () =>
          canvas.evaluate((element: HTMLCanvasElement) => {
            const context = element.getContext('2d');
            if (!context) return 0;
            const pixels = context.getImageData(0, 0, element.width, element.height).data;
            let redPixels = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i]! > 180 && pixels[i + 1]! < 80 && pixels[i + 2]! < 80 && pixels[i + 3]! > 20) {
                redPixels++;
              }
            }
            return redPixels;
          }),
        { timeout: 5000 }
      )
      .toBeGreaterThan(200);

    await canvas.screenshot({ path: testInfo.outputPath('regular-message-background.png') });

    const overlayErrors = runtimeErrors.filter((error) =>
      /yt-live-chat-overlay|danmaku|renderer|worker/i.test(error)
    );
    expect(overlayErrors).toEqual([]);
  });

  test('overlay does not throw errors during initialization', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupOverlayPage(page);

    // Filter for overlay-related errors only
    const overlayErrors = errors.filter((e) =>
      e.toLowerCase().includes('yt-live-chat-overlay')
      || e.toLowerCase().includes('overlay')
      || e.toLowerCase().includes('danmaku')
    );

    expect(overlayErrors).toHaveLength(0);
  });

  test('overlay container has proper aria attributes', async ({ page }) => {
    await setupOverlayPage(page);

    const overlay = page.locator(`#${OVERLAY_ID}`);
    await expect(overlay).toBeAttached({ timeout: 5000 });

    // The overlay container gets role="region" and aria-label in overlay.ts
    const role = await overlay.getAttribute('role');
    expect(role).toBe('region');

    // Check aria-live region exists inside overlay
    const liveRegion = page.locator(`#${OVERLAY_ID}-status`);
    const exists = (await liveRegion.count()) > 0;
    // The status region may not be created on every setup, but check if it exists
    if (exists) {
      const ariaLive = await liveRegion.getAttribute('aria-live');
      expect(ariaLive).toBe('polite');
    }
  });
});
