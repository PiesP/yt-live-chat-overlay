import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranslatorInstance } from '@platform/translation-adapter';
import { TranslationService } from '@translation/service';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (!resolve) throw new Error('Deferred resolver was not initialized');
      resolve(value);
    },
    reject: (reason?: unknown) => {
      if (!reject) throw new Error('Deferred rejecter was not initialized');
      reject(reason);
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
  } as unknown as TranslatorInstance & {
    destroy: ReturnType<typeof vi.fn>;
    translate: ReturnType<typeof vi.fn>;
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

  it('resolves non-empty translations immediately after disable and destroy', async () => {
    const firstTranslator = makeTranslator('first');
    const secondTranslator = makeTranslator('second');
    const create = vi.fn().mockResolvedValueOnce(firstTranslator).mockResolvedValueOnce(secondTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    await service.configure({ enabled: false, service: 'auto', source: 'en', target: 'ja' });
    await expect(
      Promise.race([service.translate('after-disable'), Promise.resolve<'pending'>('pending')])
    ).resolves.toBeNull();

    service.destroy();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    service.destroy();
    await expect(
      Promise.race([service.translate('after-destroy'), Promise.resolve<'pending'>('pending')])
    ).resolves.toBeNull();
  });

  it('does not let the old translator process entries from a pending generation', async () => {
    const oldTranslator = makeTranslator('old');
    const newTranslator = makeTranslator('new');
    const newCreation = deferred<TranslatorInstance>();
    const newCreationStarted = deferred<void>();
    const create = vi.fn().mockResolvedValueOnce(oldTranslator).mockImplementationOnce(() => {
      newCreationStarted.resolve(undefined);
      return newCreation.promise;
    });
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
    await newCreationStarted.promise;

    const queued = service.translate('queued');
    expect(oldTranslator.translate).not.toHaveBeenCalled();

    newCreation.resolve(newTranslator);
    await replacement;
    await expect(queued).resolves.toBe('new:queued');
    expect(oldTranslator.translate).not.toHaveBeenCalled();
    service.destroy();
  });

  it('uses the pending generation for a synchronous translate after configure starts', async () => {
    const oldTranslator = makeTranslator('old');
    const newTranslator = makeTranslator('new');
    const newCreation = deferred<TranslatorInstance>();
    const newCreationStarted = deferred<void>();
    const create = vi.fn().mockResolvedValueOnce(oldTranslator).mockImplementationOnce(() => {
      newCreationStarted.resolve(undefined);
      return newCreation.promise;
    });
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
    const synchronous = service.translate('synchronous');

    expect(oldTranslator.translate).not.toHaveBeenCalled();
    await newCreationStarted.promise;
    newCreation.resolve(newTranslator);
    await replacement;
    await expect(synchronous).resolves.toBe('new:synchronous');
    service.destroy();
  });

  it('resolves entries for a failed pending generation without using the old translator', async () => {
    const oldTranslator = makeTranslator('old');
    const newCreation = deferred<TranslatorInstance>();
    const newCreationStarted = deferred<void>();
    const create = vi.fn().mockResolvedValueOnce(oldTranslator).mockImplementationOnce(() => {
      newCreationStarted.resolve(undefined);
      return newCreation.promise;
    });
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
    await newCreationStarted.promise;

    const queued = service.translate('queued');
    expect(oldTranslator.translate).not.toHaveBeenCalled();

    newCreation.reject(new Error('download failed'));
    await replacement;
    await expect(queued).resolves.toBeNull();
    expect(oldTranslator.translate).not.toHaveBeenCalled();
    service.destroy();
  });

  it('cancels a never-resolving create so the latest configure can proceed', async () => {
    const staleCreation = deferred<TranslatorInstance>();
    const latestTranslator = makeTranslator('latest');
    const staleCreateStarted = deferred<void>();
    const create = vi.fn().mockImplementationOnce(() => {
      staleCreateStarted.resolve(undefined);
      return staleCreation.promise;
    }).mockResolvedValueOnce(latestTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    const stale = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ja',
    });
    await staleCreateStarted.promise;

    const latest = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });

    await expect(latest).resolves.toBeUndefined();
    await expect(stale).resolves.toBeUndefined();
    await expect(service.translate('hello')).resolves.toBe('latest:hello');
    service.destroy();
  });

  it('disposes a translator that resolves after its create was cancelled', async () => {
    const staleTranslator = makeTranslator('stale');
    const staleCreation = deferred<TranslatorInstance>();
    const latestTranslator = makeTranslator('latest');
    const staleCreateStarted = deferred<void>();
    const create = vi.fn().mockImplementationOnce(() => {
      staleCreateStarted.resolve(undefined);
      return staleCreation.promise;
    }).mockResolvedValueOnce(latestTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    const stale = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ja',
    });
    await staleCreateStarted.promise;

    const latest = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    await latest;

    staleCreation.resolve(staleTranslator);
    await stale;
    await Promise.resolve();

    expect(staleTranslator.destroy).toHaveBeenCalledTimes(1);
    expect(latestTranslator.destroy).not.toHaveBeenCalled();
    service.destroy();
  });

  it('cancels a never-settling translation so a later generation can drain', async () => {
    const oldTranslator = makeTranslator('old');
    const staleTranslation = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => staleTranslation.promise);
    const newTranslator = makeTranslator('new');
    const newTranslationStarted = deferred<void>();
    newTranslator.translate.mockImplementationOnce((text: string) => {
      newTranslationStarted.resolve(undefined);
      return Promise.resolve(`new:${text}`);
    });
    const create = vi.fn().mockResolvedValueOnce(oldTranslator).mockResolvedValueOnce(newTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const inFlight = service.translate('never-settles');
    expect(oldTranslator.translate).toHaveBeenCalledWith('never-settles');

    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    const later = service.translate('later');
    await newTranslationStarted.promise;

    await expect(inFlight).resolves.toBeNull();
    await expect(later).resolves.toBe('new:later');
    service.destroy();
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
    await expect(inFlight).resolves.toBeNull();

    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    const first = service.translate('first');
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
    staleTranslation.resolve('stale');
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

  it('settles translations after the recovery cycle cap is reached', async () => {
    const translators = [makeTranslator('first'), makeTranslator('second'), makeTranslator('third')];
    for (const translator of translators) {
      translator.translate.mockRejectedValue(new Error('translator failed'));
    }
    const create = vi
      .fn()
      .mockResolvedValueOnce(translators[0])
      .mockResolvedValueOnce(translators[1])
      .mockResolvedValueOnce(translators[2]);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    for (let cycle = 0; cycle < 3; cycle++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        await expect(service.translate(`failure-${cycle}-${attempt}`)).resolves.toBeNull();
      }
      if (cycle < 2) {
        await service.onUserActivation();
      }
    }

    await expect(service.translate('first-after-cap')).resolves.toBeNull();
    const secondAfterCap = service.translate('second-after-cap');
    await Promise.resolve();
    expect((service as unknown as { translateQueue: unknown[] }).translateQueue).toHaveLength(0);
    await expect(secondAfterCap).resolves.toBeNull();
    service.destroy();
  });

  it('refuses capped automatic activation retries but lets explicit configure reset recovery', async () => {
    const translators = [
      makeTranslator('first'),
      makeTranslator('second'),
      makeTranslator('third'),
      makeTranslator('explicit'),
      makeTranslator('after-reset'),
    ];
    for (const translator of translators.slice(0, 4)) {
      translator.translate.mockRejectedValue(new Error('translator failed'));
    }
    const create = vi
      .fn()
      .mockResolvedValueOnce(translators[0])
      .mockResolvedValueOnce(translators[1])
      .mockResolvedValueOnce(translators[2])
      .mockResolvedValueOnce(translators[3])
      .mockResolvedValueOnce(translators[4]);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    for (let cycle = 0; cycle < 3; cycle++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        await expect(service.translate(`failure-${cycle}-${attempt}`)).resolves.toBeNull();
      }
      if (cycle < 2) {
        await service.onUserActivation();
      }
    }

    await service.onUserActivation();
    expect(create).toHaveBeenCalledTimes(3);

    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    expect(create).toHaveBeenCalledTimes(4);

    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(service.translate(`post-reset-failure-${attempt}`)).resolves.toBeNull();
    }
    await service.onUserActivation();

    expect(create).toHaveBeenCalledTimes(5);
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

  it('serializes configure after an in-flight source detection', async () => {
    const oldTranslator = makeTranslator('old');
    const detectedTranslator = makeTranslator('detected');
    const configuredTranslator = makeTranslator('configured');
    const detectionCreation = deferred<TranslatorInstance>();
    const detectionCreateStarted = deferred<void>();
    const configureCreateStarted = deferred<void>();
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockImplementationOnce(() => {
        detectionCreateStarted.resolve(undefined);
        return detectionCreation.promise;
      })
      .mockImplementationOnce(() => {
        configureCreateStarted.resolve(undefined);
        return Promise.resolve(configuredTranslator);
      });
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const detection = service.setDetectedSource('ko');
    await detectionCreateStarted.promise;
    const configure = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    expect(create).toHaveBeenCalledTimes(2);

    detectionCreation.resolve(detectedTranslator);
    await detection;
    await configureCreateStarted.promise;
    await configure;
    expect(create).toHaveBeenCalledTimes(3);
    service.destroy();
  });
});
