import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExtensionContentConfig } from '../../../tooling/vite/configs/extension-content.ts';
import { createExtensionPageConfig } from '../../../tooling/vite/configs/extension-page.ts';

const buildEnv = { command: 'build', isPreview: false, isSsrBuild: false, mode: 'production' } as const;
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../..', 'package.json'), 'utf8')
) as { version: string };

type ConfigFactory = (env: typeof buildEnv) => Promise<unknown> | unknown;
type ExtensionConfigFactory = (browser: 'chrome' | 'firefox') => unknown;
let originalBuildVersion: string | undefined;

async function resolveIifeConfig(factory: ExtensionConfigFactory, browser: 'chrome' | 'firefox') {
  const config = factory(browser) as ConfigFactory;
  return (await config(buildEnv)) as {
    build?: {
      emptyOutDir?: boolean;
      lib?: { entry?: string; fileName?: () => string; formats?: string[]; name?: string };
      minify?: boolean;
      outDir?: string;
      sourcemap?: boolean;
      target?: string;
    };
    define?: Record<string, string>;
    plugins?: Array<{ name?: string }>;
  };
}

describe('extension IIFE Vite configuration', () => {
  beforeEach(() => {
    originalBuildVersion = process.env.BUILD_VERSION;
    delete process.env.BUILD_VERSION;
  });

  afterEach(() => {
    if (originalBuildVersion === undefined) delete process.env.BUILD_VERSION;
    else process.env.BUILD_VERSION = originalBuildVersion;
  });

  it.each([
    {
      browser: 'chrome' as const,
      entry: 'extension/content-script.ts',
      factory: createExtensionContentConfig,
      fileName: 'content-script.js',
      name: 'YtChatOverlay',
      outDir: 'dist-extension',
      target: 'content script',
    },
    {
      browser: 'firefox' as const,
      entry: 'extension/content-script.ts',
      factory: createExtensionContentConfig,
      fileName: 'content-script.js',
      name: 'YtChatOverlay',
      outDir: 'dist-extension-firefox',
      target: 'content script',
    },
    {
      browser: 'chrome' as const,
      entry: 'extension/page-script.ts',
      factory: createExtensionPageConfig,
      fileName: 'page-script.js',
      name: 'YtChatOverlayPage',
      outDir: 'dist-extension',
      target: 'page script',
    },
    {
      browser: 'firefox' as const,
      entry: 'extension/page-script.ts',
      factory: createExtensionPageConfig,
      fileName: 'page-script.js',
      name: 'YtChatOverlayPage',
      outDir: 'dist-extension-firefox',
      target: 'page script',
    },
  ])('preserves the $browser $target artifact contract', async (expected) => {
    const config = await resolveIifeConfig(expected.factory, expected.browser);

    expect(config.build).toMatchObject({
      emptyOutDir: false,
      minify: false,
      outDir: expected.outDir,
      sourcemap: false,
      target: 'es2023',
    });
    expect(config.build?.lib).toMatchObject({
      entry: expect.stringMatching(new RegExp(`${expected.entry}$`)),
      formats: ['iife'],
      name: expected.name,
    });
    expect(config.build?.lib?.fileName?.()).toBe(expected.fileName);
    expect(config.define).toMatchObject({
      'import.meta': '{}',
    });
    expect(config.define?.__VERSION__).toContain(packageJson.version);
    expect(config.define?.__BUILD_TIME__).toMatch(/^"\d{4}-\d{2}-\d{2}T/);
    expect(config.plugins).toEqual([expect.objectContaining({ name: 'enforce-iife-format' })]);
  });

  it('uses BUILD_VERSION when supplied without changing the next config', async () => {
    process.env.BUILD_VERSION = '9.8.7';
    const overridden = await resolveIifeConfig(createExtensionContentConfig, 'chrome');

    expect(overridden.define?.__VERSION__).toBe('"9.8.7"');

    delete process.env.BUILD_VERSION;
    const defaulted = await resolveIifeConfig(createExtensionContentConfig, 'chrome');

    expect(defaulted.define?.__VERSION__).toBe(JSON.stringify(packageJson.version));
  });
});
