import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranslatorInstance } from '@platform/translation-adapter';
import { TranslationService } from '@translation/service';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (!resolve) throw new Error('Deferred resolver was not initialized');
      resolve(value);
    },
  };
}

function makeTranslator(name: string): TranslatorInstance & {
  destroy: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
} {
  return {
    translate: vi.fn(async (text: string) => `${name}:${text}`),
    destroy: vi.fn(),
  };
}

function stubTranslator(
  create: ReturnType<typeof vi.fn>,
  availability: ReturnType<typeof vi.fn>
): void {
  vi.stubGlobal('Translator', { availability, create });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TranslationService translator lifecycle', () => {
  it('destroys the old translator once after a successful language-pair change', async () => {
    const oldTranslator = makeTranslator('old');
    const newTranslator = makeTranslator('new');
    const newCreation = deferred<TranslatorInstance>();
    const create = vi.fn().mockResolvedValueOnce(oldTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const newCreationStarted = deferred<void>();
    create.mockImplementationOnce(() => {
      newCreationStarted.resolve(undefined);
      return newCreation.promise;
    });
    const replacement = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    await newCreationStarted.promise;

    expect(oldTranslator.destroy).not.toHaveBeenCalled();
    newCreation.resolve(newTranslator);
    await replacement;

    expect(oldTranslator.destroy).toHaveBeenCalledTimes(1);
    service.destroy();
  });

  it('disposes a translator created after disable without double-disposing the previous one', async () => {
    const oldTranslator = makeTranslator('old');
    oldTranslator.destroy.mockImplementation(() => {
      throw new Error('destroy failed');
    });
    const newTranslator = makeTranslator('new');
    const newCreation = deferred<TranslatorInstance>();
    const create = vi.fn().mockResolvedValueOnce(oldTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const newCreationStarted = deferred<void>();
    create.mockImplementationOnce(() => {
      newCreationStarted.resolve(undefined);
      return newCreation.promise;
    });
    const replacement = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    await newCreationStarted.promise;

    await expect(
      service.configure({ enabled: false, service: 'auto', source: 'en', target: 'ko' })
    ).resolves.toBeUndefined();
    expect(oldTranslator.destroy).toHaveBeenCalledTimes(1);

    newCreation.resolve(newTranslator);
    await replacement;
    expect(newTranslator.destroy).toHaveBeenCalledTimes(1);

    service.destroy();
    expect(oldTranslator.destroy).toHaveBeenCalledTimes(1);
    expect(newTranslator.destroy).toHaveBeenCalledTimes(1);
  });

  it('resolves stale queued and in-flight work as null after a generation change', async () => {
    const oldTranslator = makeTranslator('old');
    const staleTranslation = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => staleTranslation.promise);
    const newTranslator = makeTranslator('new');
    const create = vi.fn().mockResolvedValueOnce(oldTranslator).mockResolvedValueOnce(newTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const inFlight = service.translate('in-flight');
    expect(oldTranslator.translate).toHaveBeenCalledWith('in-flight');

    const queued = service.translate('queued');
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });

    staleTranslation.resolve('stale result');
    await expect(inFlight).resolves.toBeNull();
    await expect(queued).resolves.toBeNull();
    expect(newTranslator.translate).not.toHaveBeenCalled();

    service.destroy();
  });

  it('scopes queued translations to the pending language pair', async () => {
    const oldTranslator = makeTranslator('old');
    const oldTranslation = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => oldTranslation.promise);
    const replacementTranslator = makeTranslator('replacement');
    const restoredTranslator = makeTranslator('restored');
    const replacementCreation = deferred<TranslatorInstance>();
    const replacementCreateStarted = deferred<void>();
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockImplementationOnce(() => {
        replacementCreateStarted.resolve(undefined);
        return replacementCreation.promise;
      })
      .mockResolvedValueOnce(restoredTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const inFlight = service.translate('blocker');
    expect(oldTranslator.translate).toHaveBeenCalledWith('blocker');

    const replacement = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    await replacementCreateStarted.promise;

    const queued = service.translate('same text');
    replacementCreation.resolve(replacementTranslator);
    await replacement;
    oldTranslation.resolve('old:blocker');

    await expect(inFlight).resolves.toBeNull();
    await expect(queued).resolves.toBe('replacement:same text');
    await expect(service.translate('same text')).resolves.toBe('replacement:same text');
    expect(replacementTranslator.translate).toHaveBeenCalledTimes(1);

    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    await expect(service.translate('same text')).resolves.toBe('restored:same text');
    expect(restoredTranslator.translate).toHaveBeenCalledWith('same text');
    service.destroy();
  });

  it('resolves a destroyed in-flight caller without racing a later queue drain', async () => {
    const oldTranslator = makeTranslator('old');
    const staleTranslation = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => staleTranslation.promise);
    const newTranslator = makeTranslator('new');
    const firstTranslation = deferred<string>();
    const secondTranslation = deferred<string>();
    const newTranslateStarted = deferred<void>();
    const secondTranslateStarted = deferred<void>();
    newTranslator.translate.mockImplementation((text: string) => {
      if (text === 'first') {
        newTranslateStarted.resolve(undefined);
        return firstTranslation.promise;
      }
      secondTranslateStarted.resolve(undefined);
      return secondTranslation.promise;
    });
    const create = vi.fn().mockResolvedValueOnce(oldTranslator).mockResolvedValueOnce(newTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const inFlight = service.translate('in-flight');
    expect(oldTranslator.translate).toHaveBeenCalledWith('in-flight');

    service.destroy();
    const settledAfterDestroy = await Promise.race([
      inFlight,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);
    expect(settledAfterDestroy).toBeNull();

    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    const first = service.translate('first');
    staleTranslation.resolve('stale');
    await newTranslateStarted.promise;

    const second = service.translate('second');
    const queueOrder = Promise.race([
      secondTranslateStarted.promise.then(() => 'second'),
      firstTranslation.promise.then(() => 'first'),
    ]);
    firstTranslation.resolve('new:first');
    expect(await queueOrder).toBe('first');
    await expect(first).resolves.toBe('new:first');

    secondTranslation.resolve('new:second');
    await expect(second).resolves.toBe('new:second');
    await expect(inFlight).resolves.toBeNull();
    service.destroy();
  });

  it('lets a latest configure request restore the old pair after a replacement is pending', async () => {
    const oldTranslator = makeTranslator('old');
    const replacementTranslator = makeTranslator('replacement');
    const latestTranslator = makeTranslator('latest');
    const replacementCreation = deferred<TranslatorInstance>();
    const replacementCreateStarted = deferred<void>();
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockImplementationOnce(() => {
        replacementCreateStarted.resolve(undefined);
        return replacementCreation.promise;
      })
      .mockResolvedValueOnce(latestTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const replacement = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    await replacementCreateStarted.promise;
    const latest = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ja',
    });

    replacementCreation.resolve(replacementTranslator);
    await replacement;
    await latest;

    expect(create).toHaveBeenCalledTimes(3);
    await expect(service.translate('hello')).resolves.toBe('latest:hello');
    service.destroy();
  });

  it('serializes overlapping source detections before starting the next translator', async () => {
    const oldTranslator = makeTranslator('old');
    const firstTranslator = makeTranslator('first');
    const secondTranslator = makeTranslator('second');
    const firstCreation = deferred<TranslatorInstance>();
    const secondCreation = deferred<TranslatorInstance>();
    const firstCreateStarted = deferred<void>();
    const secondDetectionStarted = deferred<void>();
    const secondCreateStarted = deferred<void>();
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockImplementationOnce(() => {
        firstCreateStarted.resolve(undefined);
        return firstCreation.promise;
      })
      .mockImplementationOnce(() => {
        secondCreateStarted.resolve(undefined);
        return secondCreation.promise;
      });
    const availability = vi.fn().mockImplementation(
      async ({ sourceLanguage }: { sourceLanguage: string }) => {
        if (sourceLanguage === 'zh-CN') secondDetectionStarted.resolve(undefined);
        return 'available';
      }
    );
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const first = service.setDetectedSource('ko');
    await firstCreateStarted.promise;
    const second = service.setDetectedSource('zh-CN');
    const detectionOrder = Promise.race([
      secondDetectionStarted.promise.then(() => 'second'),
      firstCreation.promise.then(() => 'first'),
    ]);

    firstCreation.resolve(firstTranslator);
    expect(await detectionOrder).toBe('first');
    await first;

    await secondCreateStarted.promise;
    secondCreation.resolve(secondTranslator);
    await second;
    service.destroy();
  });
});
