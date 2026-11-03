// SPDX-License-Identifier: MIT

import { Script, createContext } from 'node:vm';

import { describe, expect, it } from 'vite-plus/test';

import { farColorPrelude, observeFarColorPage } from '../../../validation/windows/far-color';

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
