import { resolve } from 'node:path';

export type ExtensionBrowser = 'chrome' | 'firefox';

const root = resolve(import.meta.dirname, '..', '..', '..');

export function extensionTarget(browser: ExtensionBrowser): {
  manifestFile: string;
  outDir: string;
  root: string;
} {
  return browser === 'chrome'
    ? { manifestFile: 'manifest.json', outDir: 'dist-extension', root }
    : { manifestFile: 'manifest.firefox.json', outDir: 'dist-extension-firefox', root };
}
