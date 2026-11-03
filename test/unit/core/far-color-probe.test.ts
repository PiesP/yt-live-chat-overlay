// SPDX-License-Identifier: MIT

import { Script, createContext } from 'node:vm';

import { describe, expect, it } from 'vite-plus/test';

import {
  assertFarColorPixels,
  farColorPrelude,
  observeFarColorPage,
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
