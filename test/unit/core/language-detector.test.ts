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
    const availability = deferred<'available'>();
    const detector = {
      detect: vi.fn(),
      destroy: vi.fn(),
    };
    const create = vi.fn().mockResolvedValue(detector);
    vi.stubGlobal('LanguageDetector', {
      availability: () => availability.promise,
      create,
    });

    const service = new LanguageDetectorService();
    const initialization = service.initialize();
    service.destroy();
    availability.resolve('available');

    await initialization;

    expect(create).toHaveBeenCalledTimes(1);
    expect(detector.destroy).toHaveBeenCalledTimes(1);
    expect(detector.detect).not.toHaveBeenCalled();
  });
});

describe('LanguageDetectorService detection', () => {
  it('falls back to Unicode ranges when the browser API is unavailable', async () => {
    const service = new LanguageDetectorService();

    expect(await service.detect('Hello world')).toBe('en');
    expect(await service.detect('こんにちは、元気ですか')).toBe('ja');
    expect(await service.detect('안녕하세요')).toBe('ko');
    expect(await service.detect('مرحبا')).toBe('ar');
    expect(await service.detect('')).toBe('en');
  });

  it('uses the browser detector when confidence is sufficient and maps BCP 47 tags', async () => {
    const detector = {
      detect: vi.fn().mockResolvedValue([
        { detectedLanguage: 'ja-JP', confidence: 0.95 },
      ]),
      destroy: vi.fn(),
    };
    vi.stubGlobal('LanguageDetector', {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue(detector),
    });

    const service = new LanguageDetectorService();
    await service.initialize();

    expect(await service.detect('plain ASCII input')).toBe('ja');
    expect(detector.detect).toHaveBeenCalledWith('plain ASCII input');
  });

  it('uses Unicode fallback when the detector confidence is below the threshold', async () => {
    const detector = {
      detect: vi.fn().mockResolvedValue([
        { detectedLanguage: 'en-US', confidence: 0.49 },
      ]),
      destroy: vi.fn(),
    };
    vi.stubGlobal('LanguageDetector', {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue(detector),
    });

    const service = new LanguageDetectorService();
    await service.initialize();

    expect(await service.detect('これは日本語です')).toBe('ja');
  });

  it.each([
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hant', 'zh-Hant'],
    ['zh_Hant_TW', 'zh-Hant'],
    ['ZH-hans-CN', 'zh-Hans'],
  ])('preserves the Chinese script in %s', async (detectedLanguage, expected) => {
    const detector = {
      detect: vi.fn().mockResolvedValue([{ detectedLanguage, confidence: 0.95 }]),
      destroy: vi.fn(),
    };
    vi.stubGlobal('LanguageDetector', {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue(detector),
    });

    const service = new LanguageDetectorService();
    await service.initialize();

    expect(await service.detect('Chinese sample')).toBe(expected);
  });

  it('does not create a detector when the stable API reports it unavailable', async () => {
    const create = vi.fn();
    vi.stubGlobal('LanguageDetector', {
      availability: vi.fn().mockResolvedValue('unavailable'),
      create,
    });

    await new LanguageDetectorService().initialize();

    expect(create).not.toHaveBeenCalled();
  });

  it('returns the majority language across samples', async () => {
    const service = new LanguageDetectorService();

    expect(await service.detectFromSamples(['hello', 'こんにちは', 'こんにちは'])).toBe('ja');
    expect(await service.detectFromSamples([])).toBe('en');
  });
});
