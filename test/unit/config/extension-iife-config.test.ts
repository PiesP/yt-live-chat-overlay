import { describe, expect, it } from 'vitest';
import {
  createExtensionIifeConfig,
  type ExtensionIifeConfigOptions,
} from '../../../tooling/vite/configs/extension-iife.ts';

const buildEnv = { command: 'build', isPreview: false, isSsrBuild: false, mode: 'production' } as const;

type ConfigFactory = (env: typeof buildEnv) => Promise<unknown> | unknown;

async function resolveIifeConfig(
  browser: 'chrome' | 'firefox',
  options: ExtensionIifeConfigOptions
) {
  const config = createExtensionIifeConfig(browser, options) as ConfigFactory;
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
  it.each([
    {
      browser: 'chrome' as const,
      entry: 'extension/content-script.ts',
      fileName: 'content-script.js',
      name: 'YtChatOverlay',
      outDir: 'dist-extension',
      target: 'content script',
    },
    {
      browser: 'firefox' as const,
      entry: 'extension/page-script.ts',
      fileName: 'page-script.js',
      name: 'YtChatOverlayPage',
      outDir: 'dist-extension-firefox',
      target: 'page script',
    },
  ])('preserves the $browser $target artifact contract', async (expected) => {
    const config = await resolveIifeConfig(expected.browser, expected);

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
    expect(config.define?.__VERSION__).toContain('0.45.0');
    expect(config.define?.__BUILD_TIME__).toMatch(/^"\d{4}-\d{2}-\d{2}T/);
    expect(config.plugins).toEqual([expect.objectContaining({ name: 'enforce-iife-format' })]);
  });
});
