import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const monkeyRequire = createRequire(
  join(realpathSync(join(root, 'node_modules/vite-plugin-monkey')), 'package.json')
);
const postcssUrlRequire = createRequire(monkeyRequire.resolve('postcss-url'));

type CssResult = { css: string; warnings(): unknown[] };
const postcss = postcssUrlRequire('postcss') as (plugins: unknown[]) => {
  process(css: string, options: { from: string }): Promise<CssResult>;
};
const postcssUrl = monkeyRequire('postcss-url') as (options: {
  filter: string;
  url: 'inline';
  basePath: string;
  encodeType: 'base64';
}) => unknown;

describe('postcss-url scoped minimatch override', () => {
  it('uses the reviewed minimatch and filters real CSS assets before inlining', async () => {
    const minimatch = postcssUrlRequire('minimatch') as {
      filter(pattern: string): (path: string) => boolean;
    };
    const version = postcssUrlRequire('minimatch/package.json') as { version: string };
    expect(version.version).toBe('11.0.1');
    expect(minimatch.filter('**/*.svg')('test-results/example/icon.svg')).toBe(true);
    expect(minimatch.filter('**/*.svg')('test-results/example/icon.png')).toBe(false);

    const parent = join(root, 'test-results');
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, 'postcss-url-filter-'));
    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
      writeFileSync(join(directory, 'icon.svg'), svg);
      writeFileSync(join(directory, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await postcss([
        postcssUrl({
          filter: '**/*.svg',
          url: 'inline',
          basePath: directory,
          encodeType: 'base64',
        }),
      ]).process('.icon{background:url("./icon.svg")}.other{background:url("./icon.png")}', {
        from: join(directory, 'style.css'),
      });

      expect(result.css).toContain(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      );
      expect(result.css).toContain('url("./icon.png")');
      expect(result.warnings()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
