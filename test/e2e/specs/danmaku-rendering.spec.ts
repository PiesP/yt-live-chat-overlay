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
import { rendererLayout } from '@util/design-tokens';
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

  test('keeps letter-spaced text and a missing emoji fallback from overlapping neighbors', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
        configurable: true,
        value: () => {
          throw new Error('Force the main-thread renderer for Canvas call inspection');
        },
      });

      const calls: Array<{
        text: string;
        x: number;
        y: number;
        font: string;
        letterSpacing: string;
      }> = [];
      const originalFillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (
        text: string,
        x: number,
        y: number,
        maxWidth?: number
      ): void {
        calls.push({
          text,
          x,
          y,
          font: this.font,
          letterSpacing: this.letterSpacing,
        });
        if (maxWidth === undefined) {
          originalFillText.call(this, text, x, y);
        } else {
          originalFillText.call(this, text, x, y, maxWidth);
        }
      };
      (window as unknown as Record<string, unknown>).__mixedContentFillTextCalls = calls;
    });

    await setupOverlayPage(page, { platform: 'userscript' });
    await applySettings(page, {
      allowShortTextMessages: true,
      danmakuMode: 'scroll',
      depthLayersEnabled: true,
      showDebugOverlay: true,
      backgroundColors: { normal: '#00000000' },
      showAuthor: { normal: false },
      outline: { enabled: false, widthPx: 0, opacity: 0 },
    });

    await page.route('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat**', (route) =>
      route.fulfill({
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [
                {
                  addChatItemAction: {
                    item: {
                      liveChatTextMessageRenderer: {
                        id: 'e2e-mixed-0',
                        authorName: { simpleText: 'Mixed Content Author' },
                        message: {
                          runs: [
                            { text: 'MIXED CONTENT' },
                            {
                              emoji: {
                                shortcuts: ['웃는 얼굴'],
                                image: {
                                  accessibility: {
                                    accessibilityData: { label: '웃는 얼굴' },
                                  },
                                  thumbnails: [
                                    {
                                      url: 'https://yt3.ggpht.com/e2e-missing-emoji=s32',
                                      width: 32,
                                      height: 32,
                                    },
                                  ],
                                },
                              },
                            },
                            { text: 'NEXT' },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
              continuations: [],
            },
          },
        },
      })
    );
    await page.evaluate(() =>
      fetch('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=e2e')
    );

    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );

    const readLayout = () =>
      page.evaluate(() => {
        const calls = (window as unknown as Record<string, unknown>)
          .__mixedContentFillTextCalls as Array<{
          text: string;
          x: number;
          y: number;
          font: string;
          letterSpacing: string;
        }>;
        for (let index = calls.length - 3; index >= 0; index--) {
          const text = calls[index];
          const fallback = calls[index + 1];
          const next = calls[index + 2];
          if (
            text?.text !== 'MIXED CONTENT' ||
            fallback?.text !== '웃는 얼굴' ||
            next?.text !== 'NEXT' ||
            text.y !== fallback.y ||
            fallback.y !== next.y
          ) {
            continue;
          }

          const reference = document.createElement('canvas');
          const context = reference.getContext('2d');
          if (!context) return null;
          context.font = text.font;
          const measureLayoutWidth = (value: string): number => {
            const metrics = context.measureText(value);
            const inkWidth =
              Math.abs(metrics.actualBoundingBoxLeft) +
              Math.abs(metrics.actualBoundingBoxRight);
            return Math.ceil(Math.max(metrics.width, inkWidth));
          };

          return {
            textAdvance: fallback.x - text.x,
            minimumTextAdvance: measureLayoutWidth(text.text) + 12,
            fallbackAdvance: next.x - fallback.x,
            minimumFallbackAdvance:
              measureLayoutWidth(fallback.text) +
              Math.max(0, Array.from(fallback.text).length - 1) *
                (Number.parseFloat(fallback.letterSpacing) || 0) +
              4,
            letterSpacing: text.letterSpacing,
          };
        }
        return null;
      });

    await expect.poll(readLayout, { timeout: 5000 }).not.toBeNull();
    const layout = await readLayout();
    expect(layout).not.toBeNull();
    expect(layout!.letterSpacing).toBe('1px');
    expect(layout!.textAdvance).toBeGreaterThanOrEqual(layout!.minimumTextAdvance);
    expect(layout!.fallbackAdvance).toBeGreaterThanOrEqual(layout!.minimumFallbackAdvance);
  });

  test('keeps a truncated SuperChat ellipsis inside the card', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
        configurable: true,
        value: () => {
          throw new Error('Force the main-thread renderer for SuperChat call inspection');
        },
      });

      const calls: Array<{ text: string; x: number; y: number; font: string }> = [];
      const cardWidths: number[] = [];
      const originalFillText = CanvasRenderingContext2D.prototype.fillText;
      const originalRoundRect = CanvasRenderingContext2D.prototype.roundRect;
      CanvasRenderingContext2D.prototype.fillText = function (
        text: string,
        x: number,
        y: number,
        maxWidth?: number
      ): void {
        calls.push({ text, x, y, font: this.font });
        if (maxWidth === undefined) {
          originalFillText.call(this, text, x, y);
        } else {
          originalFillText.call(this, text, x, y, maxWidth);
        }
      };
      CanvasRenderingContext2D.prototype.roundRect = function (
        x: number,
        y: number,
        width: number,
        height: number,
        radii?: number | DOMPointInit | (number | DOMPointInit)[]
      ): void {
        cardWidths.push(width);
        originalRoundRect.call(this, x, y, width, height, radii);
      };
      const state = window as unknown as Record<string, unknown>;
      state.__paidCardFillTextCalls = calls;
      state.__paidCardRoundRectWidths = cardWidths;
    });

    await setupOverlayPage(page, { platform: 'userscript' });
    await applySettings(page, {
      allowShortTextMessages: true,
      danmakuMode: 'top',
      showDebugOverlay: true,
      showSuperChatAmount: false,
      superChatMaxBodyLines: 2,
      showAuthor: { superChat: false },
      outline: { enabled: false, widthPx: 0, opacity: 0 },
    });

    await page.route('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat**', (route) =>
      route.fulfill({
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [
                {
                  addChatItemAction: {
                    item: {
                      liveChatPaidMessageRenderer: {
                        id: 'e2e-long-superchat',
                        authorName: { simpleText: 'SuperChat Author' },
                        purchaseAmountText: { simpleText: '$5.00' },
                        message: { simpleText: ':'.repeat(400) },
                      },
                    },
                  },
                },
              ],
              continuations: [],
            },
          },
        },
      })
    );
    await page.evaluate(() =>
      fetch('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=e2e-superchat')
    );

    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );

    const readContainment = () =>
      page.evaluate(() => {
        const state = window as unknown as Record<string, unknown>;
        const calls = state.__paidCardFillTextCalls as Array<{
          text: string;
          x: number;
          y: number;
          font: string;
        }>;
        const cardWidths = state.__paidCardRoundRectWidths as number[];
        for (let index = calls.length - 1; index > 0; index--) {
          const ellipsis = calls[index];
          const line = calls[index - 1];
          if (ellipsis?.text !== '…' || !line || !/^:+$/u.test(line.text)) continue;
          if (line.y !== ellipsis.y) continue;

          const reference = document.createElement('canvas');
          const context = reference.getContext('2d');
          if (!context) return null;
          context.font = ellipsis.font;
          const metrics = context.measureText(ellipsis.text);
          const ellipsisWidth = Math.ceil(
            Math.max(
              metrics.width,
              Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight)
            )
          );
          return {
            cardWidth: Math.max(...cardWidths),
            ellipsisRight: ellipsis.x + ellipsisWidth,
            lineStart: line.x,
          };
        }
        return null;
      });

    await expect.poll(readContainment, { timeout: 5000 }).not.toBeNull();
    const containment = await readContainment();
    expect(containment).not.toBeNull();
    expect(containment!.ellipsisRight).toBeLessThanOrEqual(
      containment!.lineStart +
        containment!.cardWidth -
        rendererLayout.superchat.paddingH * 2
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
      motionBlurEnabled: false,
      outline: { enabled: false },
      showAuthor: { normal: false },
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
    const readCardBounds = (): Promise<{
      background: { minX: number; minY: number; maxX: number; maxY: number; count: number } | null;
      text: { minX: number; minY: number; maxX: number; maxY: number; count: number } | null;
    }> =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d');
        if (!context) return { background: null, text: null };
        const image = context.getImageData(0, 0, element.width, element.height);
        type Bounds = {
          minX: number;
          minY: number;
          maxX: number;
          maxY: number;
          count: number;
        };
        const background: Bounds = {
          minX: image.width,
          minY: image.height,
          maxX: -1,
          maxY: -1,
          count: 0,
        };
        const text: Bounds = { ...background };
        const include = (bounds: Bounds, x: number, y: number): void => {
          bounds.minX = Math.min(bounds.minX, x);
          bounds.minY = Math.min(bounds.minY, y);
          bounds.maxX = Math.max(bounds.maxX, x);
          bounds.maxY = Math.max(bounds.maxY, y);
          bounds.count++;
        };

        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            const offset = (y * image.width + x) * 4;
            const red = image.data[offset]!;
            const green = image.data[offset + 1]!;
            const blue = image.data[offset + 2]!;
            const alpha = image.data[offset + 3]!;
            if (red > 180 && green < 80 && blue < 80 && alpha > 20) {
              include(background, x, y);
            }
            if (red > 200 && green > 200 && blue > 200 && alpha > 100) {
              include(text, x, y);
            }
          }
        }
        return {
          background: background.count > 0 ? background : null,
          text: text.count > 0 ? text : null,
        };
      });

    await expect.poll(readCardBounds, { timeout: 5000 }).toMatchObject({
      background: { count: expect.any(Number) },
      text: { count: expect.any(Number) },
    });
    const bounds = await readCardBounds();
    expect(bounds.background).not.toBeNull();
    expect(bounds.text).not.toBeNull();
    expect(bounds.background!.count).toBeGreaterThan(200);
    expect(bounds.text!.count).toBeGreaterThan(20);
    expect(bounds.background!.minX).toBeLessThan(bounds.text!.minX);
    expect(bounds.background!.minY).toBeLessThan(bounds.text!.minY);
    expect(bounds.background!.maxX).toBeGreaterThan(bounds.text!.maxX);
    expect(bounds.background!.maxY).toBeGreaterThan(bounds.text!.maxY);

    await canvas.screenshot({ path: testInfo.outputPath('regular-message-background.png') });

    const overlayErrors = runtimeErrors.filter((error) =>
      /yt-live-chat-overlay|danmaku|renderer|worker/i.test(error)
    );
    expect(overlayErrors).toEqual([]);
  });

  test('anchors fixed comments to the selected top and bottom safe-zone edges', async ({
    page,
  }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });
    await page.addInitScript(() => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
        configurable: true,
        value: () => {
          throw new Error('Force the main-thread renderer for fixed-position pixel inspection');
        },
      });
    });

    await setupOverlayPage(page, { platform: 'userscript' });
    await applySettings(page, {
      allowShortTextMessages: true,
      backgroundColors: { normal: '#FF0000B3' },
      danmakuMode: 'top',
      motionBlurEnabled: false,
      outline: { enabled: false },
      safeTop: 0.1,
      safeBottom: 0.1,
      showAuthor: { normal: false },
      showDebugOverlay: true,
      topBottomDurationMs: 1200,
    });

    const appendComment = (id: string, text: string): Promise<void> =>
      page.evaluate(
        ({ messageId, messageText }) => {
          const items = document.querySelector('yt-live-chat-item-list-renderer #items');
          if (!items) throw new Error('Mock live chat items container is missing');

          const renderer = document.createElement('yt-live-chat-text-message-renderer');
          renderer.id = messageId;
          const author = document.createElement('span');
          author.id = 'author-name';
          author.textContent = 'Position Author';
          const message = document.createElement('span');
          message.id = 'message';
          message.textContent = messageText;
          renderer.append(author, message);
          items.append(renderer);
        },
        { messageId: id, messageText: text }
      );

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    const readInkBounds = (): Promise<{
      minY: number;
      maxY: number;
      height: number;
      count: number;
    } | null> =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d');
        if (!context) return null;
        const image = context.getImageData(0, 0, element.width, element.height);
        let minY = image.height;
        let maxY = -1;
        let count = 0;
        for (let offset = 3; offset < image.data.length; offset += 4) {
          if (image.data[offset]! <= 20) continue;
          const y = Math.floor((offset - 3) / 4 / image.width);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          count++;
        }
        return count > 0 ? { minY, maxY, height: image.height, count } : null;
      });

    await appendComment('e2e-fixed-top', 'TOP SAFE ZONE');
    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );
    await expect.poll(readInkBounds, { timeout: 5000 }).not.toBeNull();
    const topBounds = await readInkBounds();
    expect(topBounds).not.toBeNull();
    expect(topBounds!.count).toBeGreaterThan(100);
    expect(topBounds!.maxY).toBeLessThan(topBounds!.height / 2);
    await canvas.screenshot({ path: testInfo.outputPath('fixed-top-position.png') });

    await expect.poll(readInkBounds, { timeout: 7000 }).toBeNull();
    await applySettings(page, {
      backgroundColors: { normal: '#0000FFB3' },
      danmakuMode: 'bottom',
    });
    await page.evaluate(async () => {
      const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay as
        | { restartRuntime?: () => Promise<void> }
        | undefined;
      if (typeof handle?.restartRuntime !== 'function') {
        throw new Error('Overlay restart handle is not ready');
      }
      await handle.restartRuntime();
    });
    await expect(canvas).toBeAttached();
    await appendComment('e2e-fixed-bottom', 'BOTTOM SAFE ZONE');
    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );
    await expect.poll(readInkBounds, { timeout: 5000 }).not.toBeNull();
    const bottomBounds = await readInkBounds();
    expect(bottomBounds).not.toBeNull();
    expect(bottomBounds!.count).toBeGreaterThan(100);
    expect(bottomBounds!.minY).toBeGreaterThan(bottomBounds!.height / 2);
    expect(bottomBounds!.minY).toBeGreaterThan(topBounds!.maxY);
    await canvas.screenshot({ path: testInfo.outputPath('fixed-bottom-position.png') });

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
