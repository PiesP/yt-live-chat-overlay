// SPDX-License-Identifier: MIT

import { Script, createContext } from 'node:vm';

import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  assertFarColorPixels,
  farColorPrelude,
  observeFarColorPage,
  waitForFarColorPageReady,
} from '../../../validation/windows/far-color';

// This checks serialized observer code, not the production color policy.
describe('source-bound FAR observer', () => {
  it('serializes a self-contained prelude and appends a parseable Worker observer', async () => {
    const context = createContext({
      Blob,
      Worker: class {},
      HTMLMediaElement: class {},
      window: {},
    });
    new Script(farColorPrelude(false)).runInContext(context);
    const source =
      'function renderRegularMessage(){};var OffscreenCanvas;var renderer={handleMessage(){},activeMessages:[]};self.onmessage=e=>{renderer.handleMessage(e)};';
    Object.assign(context, { source });
    const blob: Blob = new Script('new Blob([source],{type:"text/javascript"})').runInContext(
      context
    );
    const observed = await blob.text();
    expect(observed.startsWith(source)).toBe(true);
    expect(observed).toContain('globalThis.__ytFarRenderer=renderer;');
    expect(() => new Script(observed)).not.toThrow();
  });

  it('rejects packaged drift and preserves the original page bytes around its insertion', () => {
    expect(() => observeFarColorPage('main();')).toThrow();
    const source = 'function renderRegularMessage(){}\n\tmain();\n';
    expect(observeFarColorPage(source)).toMatch(/^function renderRegularMessage\(\)\{\}/);
    expect(observeFarColorPage(source).endsWith('\n\tmain();\n')).toBe(true);
  });
});

describe('FAR imported-alpha pixel predicate', () => {
  it('accepts alpha 136 and ignores opaque pixels of a different color', () => {
    expect(
      assertFarColorPixels(
        [
          [201, 23, 23, 136],
          [201, 23, 23, 50],
          [255, 255, 255, 255],
        ],
        [201, 23, 23],
        136
      )
    ).toEqual({ matchedPixels: 2, maxAlpha: 136, alphaUpperBound: 136 });
  });

  it('rejects matching text pixels exceeding the independent #f008 alpha ceiling', () => {
    expect(() => assertFarColorPixels([[201, 23, 23, 137]], [201, 23, 23], 136)).toThrow(
      /exceeds 136/
    );
    expect(() => assertFarColorPixels([[201, 23, 23, 255]], [201, 23, 23], 136)).toThrow(
      /unlayered text draw/
    );
  });

  it('retains the opaque case and rejects absent positive-alpha matched text', () => {
    expect(assertFarColorPixels([[201, 23, 23, 255]], [201, 23, 23])).toEqual({
      matchedPixels: 1,
      maxAlpha: 255,
      alphaUpperBound: null,
    });
    expect(() =>
      assertFarColorPixels(
        [
          [201, 23, 23, 0],
          [255, 255, 255, 255],
        ],
        [201, 23, 23],
        136
      )
    ).toThrow(/Visible pixels disagree/);
  });
});

describe('FAR native page readiness ordering', () => {
  it('waits for asynchronous production readiness before asserting the exact native injection', async () => {
    const order: string[] = ['domcontentloaded'];
    let releaseCanvas = (): void => {};
    let releaseApp = (): void => {};
    const canvasReady = new Promise<void>((resolve) => {
      releaseCanvas = resolve;
    });
    const appReady = new Promise<void>((resolve) => {
      releaseApp = resolve;
    });
    const waitForCanvas = vi.fn(() => {
      order.push('wait-canvas');
      return canvasReady;
    });
    const waitForFunction = vi.fn(() => {
      order.push('wait-app');
      return appReady;
    });
    const page = {
      locator: vi.fn(() => ({ waitFor: waitForCanvas })),
      waitForFunction,
    } as unknown as Pick<Page, 'locator' | 'waitForFunction'>;
    let injected = false;
    const probe = {
      assertInjected: vi.fn(async () => {
        expect(injected).toBe(true);
        order.push('assert-exact-injection');
      }),
      restore: vi.fn(async () => {
        order.push('restore');
      }),
    };
    const pending = waitForFarColorPageReady(page, probe);
    expect(probe.assertInjected).not.toHaveBeenCalled();
    expect(probe.restore).not.toHaveBeenCalled();
    releaseCanvas();
    await Promise.resolve();
    expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, {
      timeout: 15_000,
    });
    expect(probe.assertInjected).not.toHaveBeenCalled();
    injected = true;
    releaseApp();
    await pending;
    expect(waitForCanvas).toHaveBeenCalledWith({ state: 'attached', timeout: 15_000 });
    expect(order).toEqual([
      'domcontentloaded',
      'wait-canvas',
      'wait-app',
      'assert-exact-injection',
      'restore',
    ]);
  });

  it('propagates unavailable readiness and leaves probe cleanup with the fixture owner', async () => {
    const page = {
      locator: () => ({
        waitFor: async () => {
          throw new Error('Production canvas did not attach');
        },
      }),
      waitForFunction: vi.fn(),
    } as unknown as Pick<Page, 'locator' | 'waitForFunction'>;
    const probe = { assertInjected: vi.fn(), restore: vi.fn() };
    await expect(waitForFarColorPageReady(page, probe)).rejects.toThrow(
      'Production canvas did not attach'
    );
    expect(probe.assertInjected).not.toHaveBeenCalled();
    expect(probe.restore).not.toHaveBeenCalled();
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it('keeps a failing exact-injection assertion authoritative after readiness', async () => {
    const page = {
      locator: () => ({ waitFor: async () => {} }),
      waitForFunction: async () => {},
    } as unknown as Pick<Page, 'locator' | 'waitForFunction'>;
    const probe = {
      assertInjected: vi.fn(async () => {
        throw new Error('Native injection count is not exactly one');
      }),
      restore: vi.fn(),
    };
    await expect(waitForFarColorPageReady(page, probe)).rejects.toThrow('not exactly one');
    expect(probe.assertInjected).toHaveBeenCalledOnce();
    expect(probe.restore).not.toHaveBeenCalled();
  });
});
