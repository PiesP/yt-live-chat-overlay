// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageDetectorService } from '@translation/language-detector';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise?.(value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LanguageDetectorService lifecycle', () => {
  it('destroys a detector that finishes creating after destroy()', async () => {
    const capabilities = deferred<{ available: 'readily' }>();
    const detector = {
      detect: vi.fn(),
      destroy: vi.fn(),
    };
    const create = vi.fn().mockResolvedValue(detector);
    vi.stubGlobal('LanguageDetector', {
      capabilities: () => capabilities.promise,
      create,
    });

    const service = new LanguageDetectorService();
    const initialization = service.initialize();
    service.destroy();
    capabilities.resolve({ available: 'readily' });

    await initialization;

    expect(create).toHaveBeenCalledTimes(1);
    expect(detector.destroy).toHaveBeenCalledTimes(1);
    expect(detector.detect).not.toHaveBeenCalled();
  });
});
