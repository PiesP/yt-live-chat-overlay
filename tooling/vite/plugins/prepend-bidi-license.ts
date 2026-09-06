import type { Plugin } from 'vite';
import { BIDI_LICENSE_BANNER } from '../bidi-license.ts';

interface SourceMapPayload {
  mappings: string;
  version: number;
  [key: string]: unknown;
}

export function prependBannerWithSourceMap(
  code: string,
  sourceMapText: string,
  banner: string
): { code: string; sourceMapText: string; generatedLineOffset: number } {
  const prefix = `${banner}\n`;
  const generatedLineOffset = prefix.split('\n').length - 1;
  const parsed = JSON.parse(sourceMapText) as Partial<SourceMapPayload>;
  if (parsed.version !== 3 || typeof parsed.mappings !== 'string') {
    throw new Error('Renderer Worker source map is not a valid version 3 source map.');
  }
  parsed.mappings = `${';'.repeat(generatedLineOffset)}${parsed.mappings}`;
  return {
    code: `${prefix}${code}`,
    sourceMapText: JSON.stringify(parsed),
    generatedLineOffset,
  };
}

/** Retain the bidi-js MIT notice in the separately emitted renderer Worker. */
export function prependBidiWorkerLicensePlugin(): Plugin {
  let expectsSourceMap = false;
  return {
    name: 'prepend-bidi-worker-license',
    configResolved(config) {
      expectsSourceMap = config.build.sourcemap === true;
    },
    generateBundle(_outputOptions, bundle) {
      const worker = bundle['workers/renderer.js'];
      if (worker?.type !== 'chunk') {
        this.error('Renderer Worker chunk is missing during license injection.');
      }
      const sourceMapFileName = worker.sourcemapFileName ?? `${worker.fileName}.map`;
      const sourceMap = bundle[sourceMapFileName];
      if (sourceMap?.type === 'asset') {
        const sourceMapText =
          typeof sourceMap.source === 'string'
            ? sourceMap.source
            : new TextDecoder().decode(sourceMap.source);
        const prepended = prependBannerWithSourceMap(
          worker.code,
          sourceMapText,
          BIDI_LICENSE_BANNER
        );
        worker.code = prepended.code;
        sourceMap.source = prepended.sourceMapText;
      } else {
        if (expectsSourceMap) {
          this.error(`Renderer Worker source map is missing: ${sourceMapFileName}`);
        }
        worker.code = `${BIDI_LICENSE_BANNER}\n${worker.code}`;
      }
    },
  };
}
