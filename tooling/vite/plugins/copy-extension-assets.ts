import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export function copyExtensionAssetsPlugin(options: {
  manifestFile: string;
  outDir: string;
  root: string;
}): Plugin {
  const { manifestFile, outDir, root } = options;

  return {
    name: 'copy-extension-assets',
    writeBundle() {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(resolve(root, 'extension', manifestFile), resolve(outDir, 'manifest.json'));

      const iconsSource = resolve(root, 'extension/icons');
      if (existsSync(iconsSource)) {
        cpSync(iconsSource, resolve(outDir, 'icons'), { recursive: true });
      }
    },
  };
}
