// SPDX-License-Identifier: MIT

import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vite-plus/test';

import {
  observePublicUserscriptMedia,
  observePublicResize,
  openPublicSettingsDialog,
  PublicUserscriptRealm,
} from '../../../validation/windows/chrome-install.ts';
import {
  assessPublicImage,
  assessPublicResize,
  installPublicImageDrawProbe,
  isPublicImageUrl,
  readPublicCanvasFrame,
  readPublicOverlayPauseState,
  readSurvivingPublicImageDraws,
  selectPublicSeekTarget,
} from '../../../validation/windows/live-rendering.ts';

describe('shared public-media seek calculation', () => {
  it.each([
    { name: 'forward motion', range: { currentTime: 10, start: 0, end: 100 }, expected: 13 },
    {
      name: 'near-end backward fallback',
      range: { currentTime: 99, start: 0, end: 100 },
      expected: 96,
    },
    {
      name: 'backward preference',
      range: { currentTime: 97, start: 0, end: 100 },
      preferBackward: true,
      expected: 94,
    },
    { name: 'near-end forward', range: { currentTime: 97, start: 0, end: 100 }, expected: 99 },
    {
      name: 'backward preference at start falls forward',
      range: { currentTime: 1.5, start: 0, end: 100 },
      preferBackward: true,
      expected: 4.5,
    },
    { name: 'short window', range: { currentTime: 10, start: 8, end: 11 }, expected: null },
    {
      name: 'non-finite current time',
      range: { currentTime: NaN, start: 0, end: 100 },
      expected: null,
    },
    {
      name: 'non-finite boundary',
      range: { currentTime: 10, start: 0, end: Infinity },
      expected: null,
    },
    { name: 'no valid target', range: { currentTime: 30, start: 30, end: 32 }, expected: null },
  ])('handles $name', ({ range, preferBackward, expected }) => {
    expect(
      selectPublicSeekTarget(range, preferBackward === undefined ? {} : { preferBackward })
    ).toBe(expected);
  });
});

describe('public userscript realm authentication', () => {
  it.each([
    { names: ['YouTube Live Chat Overlay'], version: '1.2.3', expected: 'ready', installs: 1 },
    {
      names: ['YouTube Live Chat Overlay', 'YouTube Live Chat Overlay'],
      version: '1.2.3',
      expected: 'ambiguous',
      installs: 0,
    },
    { names: ['Other Script'], version: '1.2.3', expected: 'unproven', installs: 0 },
    { names: ['YouTube Live Chat Overlay'], version: 'older', expected: 'unproven', installs: 0 },
  ])(
    'installs only for a unique matching main-frame realm: $expected',
    async ({ names, version, expected, installs }) => {
      const handlers = new Map<string, (value: unknown) => void>();
      let installed = 0;
      const session = {
        on: (event: string, listener: (value: unknown) => void) => handlers.set(event, listener),
        send: async (
          method: string,
          params?: { uniqueContextId?: string; expression?: string }
        ) => {
          if (method === 'Runtime.enable') {
            names.forEach((_, index) =>
              handlers.get('Runtime.executionContextCreated')?.({
                context: {
                  id: index + 1,
                  uniqueId: `main-${index + 1}`,
                  auxData: { frameId: 'main' },
                },
              })
            );
            handlers.get('Runtime.executionContextCreated')?.({
              context: { id: 99, uniqueId: 'child-99', auxData: { frameId: 'child' } },
            });
            return {};
          }
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
          if (method === 'Runtime.evaluate') {
            if (params?.expression?.includes('GM_info'))
              return {
                result: {
                  value: {
                    name: names[Number(params.uniqueContextId?.split('-')[1]) - 1],
                    version,
                    callable: true,
                  },
                },
              };
            installed++;
            return { result: { value: undefined } };
          }
          throw new Error('Unexpected CDP command');
        },
        detach: async () => {},
      };
      const realm = new PublicUserscriptRealm(
        { newCDPSession: async () => session } as never,
        {} as never,
        '1.2.3'
      );
      await realm.start();
      expect((await realm.selectAndInstall()).status).toBe(expected);
      expect(installed).toBe(installs);
      await realm.close();
    }
  );
});

describe('installed public rendering observations', () => {
  it.each([false, true])(
    'keeps the settings failure and its open-dialog screenshot when restore fails=%s',
    async (restoreFails) => {
      let visible = false;
      let tabClicks = 0;
      const screenshots: { path: string; dialogVisible: boolean }[] = [];
      const checkbox = {
        isChecked: async () => false,
        check: async () => {
          throw new Error('Checkbox interaction failed');
        },
        setChecked: async () => {},
      };
      const modal = {
        waitFor: async ({ state }: { state: string }) => {
          expect(visible).toBe(state === 'visible');
        },
        isVisible: async () => visible,
        locator: (selector: string) => {
          if (selector === '#tab-colors')
            return {
              click: async () => {
                tabClicks++;
                if (restoreFails && tabClicks === 2) throw new Error('Restore tab failed');
              },
            };
          if (selector === 'input[name="showAuthor-normal"]') return checkbox;
          throw new Error(`Unexpected selector: ${selector}`);
        },
      };
      const button = {
        waitFor: async () => {},
        focus: async () => {},
      };
      const page = {
        locator: (selector: string) =>
          selector === '#yt-chat-overlay-settings-button' ? button : modal,
        keyboard: {
          press: async (key: string) => {
            if (key === 'Enter') visible = true;
            else if (key === 'Escape') visible = false;
            else throw new Error(`Unexpected key: ${key}`);
          },
        },
        screenshot: async ({ path }: { path: string }) => {
          screenshots.push({ path, dialogVisible: visible });
        },
      };
      const result = await observePublicUserscriptMedia(
        page as never,
        '/evidence',
        0,
        [],
        {} as never
      );
      expect(result.image).toMatchObject({
        status: 'unverified',
        reason: 'public-image-settings-ui-failed',
        settingsAction: 'enable-author-display',
        errorType: 'Error',
        settingsErrorScreenshot: 'live-0-settings-error.png',
        settingRestore: restoreFails
          ? { status: 'unverified', phase: 'select-appearance', errorType: 'Error' }
          : { status: 'passed' },
      });
      expect(result.resize.reason).toBe('public-resize-not-observed');
      expect(screenshots).toEqual([
        { path: '/evidence/live-0-settings-error.png', dialogVisible: true },
      ]);
      expect(visible).toBe(false);
    }
  );

  it('opens the hover-hidden settings control through its keyboard path', async () => {
    const actions: string[] = [];
    const modal = {
      waitFor: async ({ state }: { state: string }) => actions.push(`modal:${state}`),
    };
    const button = {
      waitFor: async ({ state }: { state: string }) => actions.push(`button:${state}`),
      focus: async () => actions.push('button:focus'),
      click: async () => {
        throw new Error('pointer click cannot reach the hidden control');
      },
    };
    const page = {
      locator: (selector: string) =>
        selector === '#yt-chat-overlay-settings-button' ? button : modal,
      keyboard: { press: async (key: string) => actions.push(`keyboard:${key}`) },
    };
    expect(await openPublicSettingsDialog(page as never)).toBe(modal);
    expect(actions).toEqual(['button:visible', 'button:focus', 'keyboard:Enter', 'modal:visible']);
  });

  const before = {
    width: 1280,
    height: 720,
    active: 3,
    dropped: 2,
    visiblePixels: 16,
  };
  const after = { ...before, width: 1600, height: 900 };

  it.each([
    { initiallyPaused: false, restoreReadFails: false },
    { initiallyPaused: true, restoreReadFails: false },
    { initiallyPaused: false, restoreReadFails: true },
    { initiallyPaused: true, restoreReadFails: true },
  ])(
    'restores viewport paint before pause (paused=$initiallyPaused, read fails=$restoreReadFails)',
    async ({ initiallyPaused, restoreReadFails }) => {
      const state = {
        overlayPaused: initiallyPaused,
        videoPaused: initiallyPaused,
        resized: false,
        backingClearedWhilePaused: false,
        backingClearCount: 0,
        paintReads: 0,
      };
      const restoreReadStates: { overlayPaused: boolean; videoPaused: boolean }[] = [];
      const screenshots: { path: string; overlayPaused: boolean; videoPaused: boolean }[] = [];
      const video = {
        get paused() {
          return state.videoPaused;
        },
        pause() {
          state.videoPaused = true;
        },
        async play() {
          state.videoPaused = false;
        },
      };
      const page = {
        locator: () => ({
          first: () => ({
            evaluate: async (
              fn: (element: typeof video, wasPaused?: boolean) => unknown,
              arg?: boolean
            ) => fn(video, arg),
          }),
        }),
        evaluate: async (fn: unknown) => {
          if (fn === readPublicOverlayPauseState) return state.overlayPaused;
          if (fn === readPublicCanvasFrame) {
            if (state.backingClearCount === 2) {
              restoreReadStates.push({
                overlayPaused: state.overlayPaused,
                videoPaused: state.videoPaused,
              });
              if (restoreReadFails) throw new Error('Canvas read unavailable');
            }
            if (state.backingClearCount > 0 && !state.overlayPaused && !state.videoPaused)
              state.paintReads++;
            return {
              frame: {
                width: state.resized ? 960 : 1280,
                height: state.resized ? 560 : 720,
                active: 2,
                dropped: 1,
                visiblePixels: state.backingClearCount === 0 || state.paintReads >= 2 ? 16 : 0,
              },
              reason: null,
              width: state.resized ? 960 : 1280,
              height: state.resized ? 560 : 720,
              dpr: 1,
            };
          }
          throw new Error('Unexpected browser evaluation');
        },
        waitForFunction: async () => {},
        keyboard: {
          press: async () => {
            state.overlayPaused = !state.overlayPaused;
          },
        },
        screenshot: async ({ path }: { path: string }) => {
          screenshots.push({
            path,
            overlayPaused: state.overlayPaused,
            videoPaused: state.videoPaused,
          });
        },
        setViewportSize: async ({ width }: { width: number }) => {
          state.resized = width !== 1280;
          state.backingClearCount++;
          state.paintReads = 0;
          if (state.resized && state.overlayPaused && state.videoPaused)
            state.backingClearedWhilePaused = true;
        },
      };
      const result = await observePublicResize(page as never, '/evidence', 0, {
        width: 1280,
        height: 720,
      });
      expect(state.backingClearedWhilePaused).toBe(true);
      expect(state.backingClearCount).toBe(2);
      expect(restoreReadStates).toHaveLength(restoreReadFails ? 1 : 2);
      expect(restoreReadStates).toEqual(
        Array.from({ length: restoreReadFails ? 1 : 2 }, () => ({
          overlayPaused: false,
          videoPaused: false,
        }))
      );
      expect(result).toMatchObject({
        status: restoreReadFails ? 'unverified' : 'passed',
        before: { visiblePixels: 16 },
        after: { visiblePixels: 16 },
        samplingPhase: 'resumed-after-resize',
        restoredOriginalState: !restoreReadFails,
        canvasReadRestored: restoreReadFails
          ? { reason: 'canvas-evaluation-failed' }
          : { width: 1280, height: 720, visiblePixels: 16 },
      });
      expect(
        screenshots.map(({ overlayPaused, videoPaused }) => [overlayPaused, videoPaused])
      ).toEqual([
        [true, true],
        [false, false],
      ]);
      expect(state.overlayPaused).toBe(initiallyPaused);
      expect(state.videoPaused).toBe(initiallyPaused);
    }
  );

  it('reads separate HUD children even when parent text concatenates labels', () => {
    class Canvas {
      width = 1280;
      height = 720;
      getContext() {
        return { getImageData: () => ({ data: [0, 0, 0, 255] }) };
      }
    }
    const lines = ['Rcvd: 4 | Rndr: 4', 'Active: 2', 'Drop: 0'];
    const realm = {
      window: { devicePixelRatio: 1.25 },
      HTMLCanvasElement: Canvas,
      document: {
        querySelector: (selector: string) =>
          selector === '#yt-live-chat-overlay canvas'
            ? new Canvas()
            : { textContent: lines.join('') },
        querySelectorAll: () => lines.map((textContent) => ({ textContent })),
      },
    };
    const read = () => runInNewContext('(' + readPublicCanvasFrame.toString() + ')()', realm);
    expect(read()).toEqual({
      frame: { width: 1280, height: 720, active: 2, dropped: 0, visiblePixels: 1 },
      reason: null,
      width: 1280,
      height: 720,
      dpr: 1.25,
    });
    lines.splice(0, lines.length, 'Active: 2Drop: 0');
    expect(read().reason).toBe('debug-counters-missing');
    lines.splice(0, lines.length, 'Drop: 0', 'Active: 2');
    realm.document.querySelector = (selector: string) =>
      selector === '#yt-live-chat-overlay canvas'
        ? new (class extends Canvas {
            override getContext() {
              return {
                getImageData: () => {
                  throw new Error('tainted');
                },
              };
            }
          })()
        : { textContent: lines.join('') };
    expect(read()).toMatchObject({
      frame: null,
      reason: 'canvas-pixel-read-failed',
      width: 1280,
      height: 720,
      dpr: 1.25,
    });
  });

  it('requires changed backing geometry and still-visible paused comments', () => {
    expect(assessPublicResize(before, after)).toBeNull();
    expect(assessPublicResize(null, after)).toBe('canvas-or-debug-unavailable');
    expect(assessPublicResize({ ...before, active: 0 }, after)).toBe('visible-message-unavailable');
    expect(assessPublicResize(before, { ...after, width: 1280, height: 720 })).toBe(
      'canvas-size-unchanged'
    );
    expect(assessPublicResize(before, { ...after, active: 2 })).toBe('active-message-lost');
    expect(assessPublicResize(before, { ...after, dropped: 3 })).toBeNull();
    expect(assessPublicResize(before, { ...after, visiblePixels: 0 })).toBe(
      'visible-canvas-ink-lost'
    );
    expect(assessPublicResize(before, { ...after, dropped: NaN })).toBe('canvas-or-debug-invalid');
  });

  it('accepts only a visible CDN image draw with a matching successful image response', () => {
    const draw = {
      url: 'https://yt3.ggpht.com/public-avatar=s88',
      sourceType: 'derived-canvas' as const,
      naturalWidth: 48,
      naturalHeight: 48,
      pixelAlpha: 255,
      pixelX: 24,
      pixelY: 24,
      pixelRgba: [80, 90, 100, 255] as [number, number, number, number],
    };
    const response = { url: draw.url, status: 200, contentType: 'image/webp' };
    expect(assessPublicImage([draw], [response])).toEqual({
      status: 'passed',
      draw,
      response,
    });
    expect(assessPublicImage([], [response])).toEqual({
      status: 'unverified',
      reason: 'public-image-draw-unverified',
    });
    for (const invalid of [
      { draw: { ...draw, url: 'https://yt3.ggpht.com.evil.test/avatar' }, response },
      { draw: { ...draw, pixelAlpha: 0 }, response },
      { draw: { ...draw, pixelX: -1 }, response },
      { draw: { ...draw, pixelRgba: [80, 90, 100, 0] as typeof draw.pixelRgba }, response },
    ]) {
      expect(assessPublicImage([invalid.draw], [invalid.response])).toEqual({
        status: 'unverified',
        reason: 'public-image-draw-unverified',
      });
    }
    for (const invalid of [
      { draw, response: { ...response, status: 403 } },
      { draw, response: { ...response, contentType: 'text/html' } },
      { draw, response: { ...response, url: 'https://yt3.ggpht.com/other-avatar' } },
    ]) {
      expect(assessPublicImage([invalid.draw], [invalid.response])).toEqual({
        status: 'unverified',
        reason: 'public-image-response-unverified',
      });
    }
    expect(isPublicImageUrl('http://yt3.ggpht.com/avatar')).toBe(false);
    expect(isPublicImageUrl('https://yt3.ggpht.com.evil.test/avatar')).toBe(false);
    expect(isPublicImageUrl(draw.url)).toBe(true);
  });

  it('requires changed image pixels and rejects no-op, transparent, clipped and overpainted draws', () => {
    class Image {
      currentSrc = 'https://yt3.ggpht.com/public-avatar=s88';
      src = this.currentSrc;
      naturalWidth = 48;
      naturalHeight = 48;
    }
    class Canvas {
      width = 1280;
      height = 720;
      context: Context | null = null;
      closest() {
        return {};
      }
      getContext() {
        return this.context;
      }
    }
    class OffscreenContext {
      canvas = { width: 48, height: 48 };
      drawImage(..._args: unknown[]) {}
    }
    class Context {
      canvas = new Canvas();
      mode: 'none' | 'transparent' | 'paint' = 'none';
      pixels = new Map<string, [number, number, number, number]>();
      constructor() {
        this.canvas.context = this;
      }
      drawImage(_image: unknown, x: number, y: number, width: number, height: number) {
        if (this.mode !== 'paint') return;
        const pixelX = Math.floor(x + width / 2);
        const pixelY = Math.floor(y + height / 2);
        if (pixelX >= 0 && pixelY >= 0 && pixelX < this.canvas.width && pixelY < this.canvas.height)
          this.pixels.set(`${pixelX},${pixelY}`, [80, 90, 100, 255]);
      }
      getTransform() {
        return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      }
      getImageData(x: number, y: number) {
        return { data: this.pixels.get(`${x},${y}`) ?? [10, 20, 30, 255] };
      }
    }
    const probeWindow: Record<string, unknown> = {};
    const context = new Context();
    const realm = {
      window: probeWindow,
      WeakMap,
      HTMLImageElement: Image,
      HTMLCanvasElement: Canvas,
      OffscreenCanvasRenderingContext2D: OffscreenContext,
      CanvasRenderingContext2D: Context,
      document: { querySelector: () => context.canvas },
      Number,
      Math,
    };
    runInNewContext('(' + installPublicImageDrawProbe.toString() + ')()', realm);
    const readSurvivors = () =>
      runInNewContext('(' + readSurvivingPublicImageDraws.toString() + ')()', realm);
    const image = new Image();
    context.drawImage(image, 0, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([]);
    context.mode = 'transparent';
    context.drawImage(image, 0, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([]);
    context.mode = 'paint';
    context.drawImage(image, 1300, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([]);
    const offscreen = new OffscreenContext();
    offscreen.drawImage(image, 0, 0, 48, 48);
    context.drawImage(offscreen.canvas, 0, 0, 48, 48);
    expect(readSurvivors()).toHaveLength(1);
    context.pixels.set('24,24', [10, 20, 30, 255]);
    expect(readSurvivors()).toHaveLength(0);
    context.drawImage(offscreen.canvas, 96, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toHaveLength(1);
    expect(readSurvivors()).toHaveLength(1);
    const direct = new Image();
    direct.currentSrc = 'https://yt3.ggpht.com/direct-avatar=s88';
    context.drawImage(direct, 48, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([
      {
        url: image.src,
        sourceType: 'derived-canvas',
        naturalWidth: 48,
        naturalHeight: 48,
        pixelAlpha: 255,
        pixelX: 120,
        pixelY: 24,
        pixelRgba: [80, 90, 100, 255],
      },
      {
        url: direct.currentSrc,
        sourceType: 'image',
        naturalWidth: 48,
        naturalHeight: 48,
        pixelAlpha: 255,
        pixelX: 72,
        pixelY: 24,
        pixelRgba: [80, 90, 100, 255],
      },
    ]);
    expect(readSurvivors()).toHaveLength(2);
  });
});
