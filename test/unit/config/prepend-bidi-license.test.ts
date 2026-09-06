// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { SourceMap } from 'node:module';
import { describe, expect, it } from 'vitest';
import { prependBannerWithSourceMap } from '../../../tooling/vite/plugins/prepend-bidi-license';

describe('prepend bidi Worker license', () => {
  it('shifts generated source-map lines by the exact banner prefix', () => {
    const sourceMap = JSON.stringify({
      version: 3,
      file: 'renderer.js',
      sources: ['renderer.ts'],
      sourcesContent: ['first();\nsecond();'],
      names: [],
      mappings: 'AAAA;AACA',
    });
    const banner = '/*!\n * bidi-js\n */';

    const result = prependBannerWithSourceMap('first();\nsecond();', sourceMap, banner);
    const shifted = new SourceMap(JSON.parse(result.sourceMapText));

    expect(result.code).toBe(`${banner}\nfirst();\nsecond();`);
    expect(result.generatedLineOffset).toBe(3);
    expect(shifted.findEntry(0, 0)).toEqual({});
    expect(shifted.findEntry(2, 0)).toEqual({});
    expect(shifted.findEntry(3, 0)).toMatchObject({
      originalSource: 'renderer.ts',
      originalLine: 0,
      originalColumn: 0,
    });
    expect(shifted.findEntry(4, 0)).toMatchObject({
      originalSource: 'renderer.ts',
      originalLine: 1,
      originalColumn: 0,
    });
  });

  it('rejects malformed source maps instead of emitting stale mappings', () => {
    expect(() => prependBannerWithSourceMap('code', '{"version":3}', '/*! license */')).toThrow(
      'Renderer Worker source map is not a valid version 3 source map.'
    );
  });
});
