import type { Plugin } from 'vite';

export function enforceIifePlugin(target: string): Plugin {
  return {
    name: 'enforce-iife-format',
    enforce: 'post',
    generateBundle(options) {
      if (options.format !== 'iife') {
        throw new Error(`${target} must use IIFE format, got "${options.format}".`);
      }
    },
  };
}
