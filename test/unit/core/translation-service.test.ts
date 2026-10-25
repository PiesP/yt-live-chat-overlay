import type { TranslatorInstance } from '@platform/translation-adapter';
import { TranslationService } from '@translation/service';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

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

describe('TranslationService runtime status', () => {
  it('distinguishes preferences, missing API, unsupported pairs, and blocked setup', async () => {
    const service = new TranslationService();
    const seen: string[] = [];
    const unsubscribe = service.subscribeStatus((status) => seen.push(status.phase));
    await service.configure({ enabled: false, service: 'auto', source: 'en', target: 'ja' });
    expect(service.getStatus()).toMatchObject({ phase: 'off', reason: 'disabled' });
    await service.configure({ enabled: true, service: 'off', source: 'en', target: 'ja' });
    expect(service.getStatus()).toMatchObject({ phase: 'off', reason: 'service-off' });
    vi.stubGlobal('Translator', undefined);
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    expect(service.getStatus()).toMatchObject({ phase: 'unavailable', reason: 'api-unavailable' });

    const availability = vi
      .fn()
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValue('available');
    const blocked = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    const create = vi.fn().mockRejectedValue(blocked);
    stubTranslator(create, availability);
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    expect(service.getStatus()).toMatchObject({ phase: 'unavailable', reason: 'pair-unavailable' });
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    expect(service.getStatus()).toMatchObject({ phase: 'needs-action', reason: 'blocked' });
    expect(seen).toContain('preparing');
    unsubscribe();
    service.destroy();
  });

  it('reports actual model progress and only marks ready after create resolves', async () => {
    const creation = deferred<TranslatorInstance>();
    const monitor = new EventTarget();
    const create = vi.fn((options: { monitor?: (target: EventTarget) => void }) => {
      options.monitor?.(monitor);
      return creation.promise;
    });
    stubTranslator(create, vi.fn().mockResolvedValue('downloadable'));
    const service = new TranslationService();
    const configuring = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ja',
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(service.getStatus()).toMatchObject({ phase: 'preparing', progressPercent: null });
    monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.4, total: 1 }));
    expect(service.getStatus()).toMatchObject({ phase: 'downloading', progressPercent: 40 });
    monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1, total: 1 }));
    expect(service.getStatus()).toMatchObject({ phase: 'downloading', progressPercent: 100 });
    creation.resolve(makeTranslator('ready'));
    await configuring;
    expect(service.getStatus()).toMatchObject({ phase: 'active', source: 'en', target: 'ja' });
    expect(service.isActive).toBe(true);
    service.destroy();
  });

  it('discards old-pair progress and readiness after reconfiguration or disable', async () => {
    const oldCreation = deferred<TranslatorInstance>();
    const oldMonitor = new EventTarget();
    const oldTranslator = makeTranslator('old');
    const newTranslator = makeTranslator('new');
    const create = vi
      .fn()
      .mockImplementationOnce((options: { monitor?: (target: EventTarget) => void }) => {
        options.monitor?.(oldMonitor);
        return oldCreation.promise;
      })
      .mockResolvedValueOnce(newTranslator);
    stubTranslator(create, vi.fn().mockResolvedValue('downloadable'));
    const service = new TranslationService();
    const old = service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const latest = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    oldMonitor.dispatchEvent(
      Object.assign(new Event('downloadprogress'), { loaded: 0.8, total: 1 })
    );
    expect(service.getStatus()).toMatchObject({ phase: 'preparing', target: 'ko' });
    oldCreation.resolve(oldTranslator);
    await latest;
    await old;
    expect(service.getStatus()).toMatchObject({ phase: 'active', target: 'ko' });
    oldMonitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 1, total: 1 }));
    expect(service.getStatus()).toMatchObject({ phase: 'active', target: 'ko' });
    await vi.waitFor(() => expect(oldTranslator.destroy).toHaveBeenCalledOnce());
    await service.configure({ enabled: false, service: 'auto', source: 'en', target: 'ko' });
    expect(service.getStatus()).toMatchObject({ phase: 'off', reason: 'disabled' });
    oldMonitor.dispatchEvent(
      Object.assign(new Event('downloadprogress'), { loaded: 0.5, total: 1 })
    );
    expect(service.getStatus()).toMatchObject({ phase: 'off', reason: 'disabled' });
    service.destroy();
  });
});

describe('TranslationService translator lifecycle', () => {
  it('recovers the same translator after a stalled native call actually rejects', async () => {
    const translator = makeTranslator('ready');
    const native = deferred<string>();
    translator.translate.mockImplementationOnce(() => native.promise);
    const create = vi.fn().mockResolvedValue(translator);
    stubTranslator(create, vi.fn().mockResolvedValue('available'));
    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    vi.useFakeTimers();
    try {
      const stalled = service.translate('stalled');
      await vi.advanceTimersByTimeAsync(0);
      expect(translator.translate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(stalled).resolves.toBeNull();
      expect(service.getStatus()).toMatchObject({ phase: 'failed', reason: 'translator-failed' });
      await expect(service.translate('blocked')).resolves.toBeNull();
      expect(translator.translate).toHaveBeenCalledTimes(1);
      native.reject(new DOMException('aborted', 'AbortError'));
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus()).toMatchObject({ phase: 'active' });
      await expect(service.translate('next')).resolves.toBe('ready:next');
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      service.destroy();
      vi.useRealTimers();
    }
  });

  it('allows a same-pair settings retry after stalled native work settles', async () => {
    const oldTranslator = makeTranslator('old');
    const native = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => native.promise);
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockResolvedValueOnce(makeTranslator('new'));
    stubTranslator(create, vi.fn().mockResolvedValue('available'));
    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    vi.useFakeTimers();
    try {
      const stalled = service.translate('stalled');
      await vi.advanceTimersByTimeAsync(0);
      expect(oldTranslator.translate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(stalled).resolves.toBeNull();
      const retryWhileOwned = service.configure({
        enabled: true,
        service: 'auto',
        source: 'en',
        target: 'ja',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_500);
      await retryWhileOwned;
      expect(service.getStatus()).toMatchObject({ phase: 'failed' });
      expect(create).toHaveBeenCalledTimes(1);
      native.resolve('late');
      await Promise.resolve();
      await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
      await expect(service.translate('next')).resolves.toBe('new:next');
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      service.destroy();
      vi.useRealTimers();
    }
  });

  it('holds an unresolved create lease across service replacement', async () => {
    const staleCreation = deferred<TranslatorInstance>();
    const create = vi
      .fn()
      .mockReturnValueOnce(staleCreation.promise)
      .mockResolvedValueOnce(makeTranslator('new'));
    stubTranslator(create, vi.fn().mockResolvedValue('available'));
    const oldService = new TranslationService();
    const oldConfigure = oldService.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ja',
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    oldService.destroy();
    await oldConfigure;

    const newService = new TranslationService();
    await newService.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    expect(newService.getStatus()).toMatchObject({ phase: 'failed' });
    expect(create).toHaveBeenCalledTimes(1);

    const staleTranslator = makeTranslator('stale');
    staleCreation.resolve(staleTranslator);
    await vi.waitFor(() => expect(staleTranslator.destroy).toHaveBeenCalledOnce());
    await newService.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    expect(newService.getStatus()).toMatchObject({ phase: 'active' });
    expect(create).toHaveBeenCalledTimes(2);
    newService.destroy();
  });

  it('holds an unresolved translation lease across service replacement', async () => {
    const oldTranslator = makeTranslator('old');
    const native = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => native.promise);
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockResolvedValueOnce(makeTranslator('new'));
    stubTranslator(create, vi.fn().mockResolvedValue('available'));
    const oldService = new TranslationService();
    await oldService.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    const abandoned = oldService.translate('abandoned');
    await vi.waitFor(() => expect(oldTranslator.translate).toHaveBeenCalledTimes(1));
    oldService.destroy();
    await expect(abandoned).resolves.toBeNull();

    const newService = new TranslationService();
    await newService.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    expect(newService.getStatus()).toMatchObject({ phase: 'failed' });
    expect(create).toHaveBeenCalledTimes(1);
    native.resolve('late');
    await newService.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    await expect(newService.translate('new')).resolves.toBe('new:new');
    expect(create).toHaveBeenCalledTimes(2);
    newService.destroy();
  });

  it('withdraws an abandoned queued caller and aborts active native work without overlap', async () => {
    const translator = makeTranslator('ready');
    const firstNative = deferred<string>();
    translator.translate.mockImplementationOnce(() => firstNative.promise);
    stubTranslator(vi.fn().mockResolvedValue(translator), vi.fn().mockResolvedValue('available'));
    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const activeOwner = new AbortController();
    const queuedOwner = new AbortController();
    const active = service.translate('active', { signal: activeOwner.signal });
    await vi.waitFor(() => expect(translator.translate).toHaveBeenCalledTimes(1));
    const queued = service.translate('queued', { signal: queuedOwner.signal });
    queuedOwner.abort();
    activeOwner.abort();
    await expect(queued).resolves.toBeNull();
    await expect(active).resolves.toBeNull();
    expect(translator.translate).toHaveBeenCalledTimes(1);
    expect(translator.translate.mock.calls[0]?.[1].signal.aborted).toBe(true);

    const survivor = service.translate('survivor');
    expect(translator.translate).toHaveBeenCalledTimes(1);
    firstNative.resolve('late');
    await expect(survivor).resolves.toBe('ready:survivor');
    expect(translator.translate).toHaveBeenCalledTimes(2);
    service.destroy();
  });

  it('bounds queued bytes and gives oldest callers progress during recent high-priority arrivals', async () => {
    const translator = makeTranslator('ready');
    const blocker = deferred<string>();
    translator.translate.mockImplementationOnce(() => blocker.promise);
    stubTranslator(vi.fn().mockResolvedValue(translator), vi.fn().mockResolvedValue('available'));
    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    await expect(service.translate('x'.repeat(4097))).resolves.toBeNull();
    const first = service.translate('blocker');
    const oldest = service.translate('oldest');
    const nextOld = service.translate('next-old');
    const recent = service.translate('recent', { priority: 2 });
    const newest = service.translate('newest', { priority: 2 });
    blocker.resolve('ready:blocker');
    await Promise.all([first, oldest, nextOld, recent, newest]);
    expect(translator.translate.mock.calls.map((call) => call[0])).toEqual([
      'blocker',
      'newest',
      'recent',
      'oldest',
      'next-old',
    ]);
    service.destroy();
  });

  it('evicts oldest queued text when the 64 KiB budget is reached', async () => {
    const translator = makeTranslator('ready');
    const blocker = deferred<string>();
    translator.translate.mockImplementationOnce(() => blocker.promise);
    stubTranslator(vi.fn().mockResolvedValue(translator), vi.fn().mockResolvedValue('available'));
    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    const active = service.translate('blocker');
    await vi.waitFor(() => expect(translator.translate).toHaveBeenCalledTimes(1));
    const largeTexts = Array.from({ length: 10 }, (_, index) => `${index}`.padEnd(4096, 'x'));
    const pending = largeTexts.map((text) => service.translate(text));
    blocker.resolve('ready:blocker');
    const results = await Promise.all(pending);
    await active;
    expect(results.slice(0, 2)).toEqual([null, null]);
    expect(results.slice(2)).toEqual(largeTexts.slice(2).map((text) => `ready:${text}`));
    expect(translator.translate).toHaveBeenCalledTimes(9);
    service.destroy();
  });

  it('resets the byte ledger when destroyed with a full queue and reused', async () => {
    const oldTranslator = makeTranslator('old');
    const native = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => native.promise);
    const newTranslator = makeTranslator('new');
    stubTranslator(
      vi.fn().mockResolvedValueOnce(oldTranslator).mockResolvedValueOnce(newTranslator),
      vi.fn().mockResolvedValue('available')
    );
    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    const active = service.translate('blocker');
    await vi.waitFor(() => expect(oldTranslator.translate).toHaveBeenCalledTimes(1));
    const queued = Array.from({ length: 8 }, (_, index) =>
      service.translate(`${index}`.padEnd(4096, 'x'))
    );
    service.destroy();
    await expect(active).resolves.toBeNull();
    await expect(Promise.all(queued)).resolves.toEqual(Array(8).fill(null));
    native.resolve('late');
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    await expect(service.translate('x')).resolves.toBe('new:x');
    service.destroy();
  });

  it('reuses cached translations within a language pair and disposes the replaced translator', async () => {
    const oldTranslator = makeTranslator('old');
    const newTranslator = makeTranslator('new');
    const newCreation = deferred<TranslatorInstance>();
    const create = vi.fn().mockResolvedValueOnce(oldTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    await expect(service.translate('hello')).resolves.toBe('old:hello');
    await expect(service.translate('hello')).resolves.toBe('old:hello');
    expect(oldTranslator.translate).toHaveBeenCalledTimes(1);

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
    await expect(service.translate('hello')).resolves.toBe('new:hello');
    await expect(service.translate('hello')).resolves.toBe('new:hello');
    expect(newTranslator.translate).toHaveBeenCalledTimes(1);
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
    const create = vi
      .fn()
      .mockResolvedValueOnce(firstTranslator)
      .mockResolvedValueOnce(secondTranslator);
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
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockImplementationOnce(() => {
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
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockImplementationOnce(() => {
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
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockImplementationOnce(() => {
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

  it('does not overlap a never-resolving create with replacement creation', async () => {
    const staleCreation = deferred<TranslatorInstance>();
    const latestTranslator = makeTranslator('latest');
    const staleCreateStarted = deferred<void>();
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        staleCreateStarted.resolve(undefined);
        return staleCreation.promise;
      })
      .mockResolvedValueOnce(latestTranslator);
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
    expect(service.getStatus()).toMatchObject({ phase: 'failed', reason: 'create-failed' });
    expect(create).toHaveBeenCalledTimes(1);
    staleCreation.resolve(makeTranslator('stale'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    await expect(service.translate('hello')).resolves.toBe('latest:hello');
    service.destroy();
  });

  it('disposes a translator that resolves after its create was cancelled', async () => {
    const staleTranslator = makeTranslator('stale');
    const staleCreation = deferred<TranslatorInstance>();
    const latestTranslator = makeTranslator('latest');
    const staleCreateStarted = deferred<void>();
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        staleCreateStarted.resolve(undefined);
        return staleCreation.promise;
      })
      .mockResolvedValueOnce(latestTranslator);
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

  it('does not overlap a never-settling native translation with a new generation', async () => {
    const oldTranslator = makeTranslator('old');
    const staleTranslation = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => staleTranslation.promise);
    const newTranslator = makeTranslator('new');
    const newTranslationStarted = deferred<void>();
    newTranslator.translate.mockImplementationOnce((text: string) => {
      newTranslationStarted.resolve(undefined);
      return Promise.resolve(`new:${text}`);
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockResolvedValueOnce(newTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const inFlight = service.translate('never-settles');
    await vi.waitFor(() =>
      expect(oldTranslator.translate).toHaveBeenCalledWith('never-settles', {
        signal: expect.any(AbortSignal),
      })
    );

    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    await expect(inFlight).resolves.toBeNull();
    expect(service.getStatus()).toMatchObject({ phase: 'failed', reason: 'translator-failed' });
    expect(create).toHaveBeenCalledTimes(1);
    staleTranslation.resolve('stale');
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
    const later = service.translate('later');
    await newTranslationStarted.promise;
    await expect(later).resolves.toBe('new:later');
    service.destroy();
  });

  it('resolves stale queued and in-flight work as null after a generation change', async () => {
    const oldTranslator = makeTranslator('old');
    const staleTranslation = deferred<string>();
    oldTranslator.translate.mockImplementationOnce(() => staleTranslation.promise);
    const newTranslator = makeTranslator('new');
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockResolvedValueOnce(newTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const inFlight = service.translate('in-flight');
    await vi.waitFor(() =>
      expect(oldTranslator.translate).toHaveBeenCalledWith('in-flight', {
        signal: expect.any(AbortSignal),
      })
    );

    const queued = service.translate('queued');
    staleTranslation.resolve('stale result');
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });
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
    await vi.waitFor(() =>
      expect(oldTranslator.translate).toHaveBeenCalledWith('blocker', {
        signal: expect.any(AbortSignal),
      })
    );

    const replacement = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    const queued = service.translate('same text');
    oldTranslation.resolve('old:blocker');
    await replacementCreateStarted.promise;
    replacementCreation.resolve(replacementTranslator);
    await replacement;

    await expect(inFlight).resolves.toBeNull();
    await expect(queued).resolves.toBe('replacement:same text');
    await expect(service.translate('same text')).resolves.toBe('replacement:same text');
    expect(replacementTranslator.translate).toHaveBeenCalledTimes(1);

    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    await expect(service.translate('same text')).resolves.toBe('restored:same text');
    expect(restoredTranslator.translate).toHaveBeenCalledWith('same text', {
      signal: expect.any(AbortSignal),
    });
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
    const create = vi
      .fn()
      .mockResolvedValueOnce(oldTranslator)
      .mockResolvedValueOnce(newTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });

    const inFlight = service.translate('in-flight');
    await vi.waitFor(() =>
      expect(oldTranslator.translate).toHaveBeenCalledWith('in-flight', {
        signal: expect.any(AbortSignal),
      })
    );

    service.destroy();
    await expect(inFlight).resolves.toBeNull();

    staleTranslation.resolve('stale');
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
    const translators = [
      makeTranslator('first'),
      makeTranslator('second'),
      makeTranslator('third'),
    ];
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
    const availability = vi
      .fn()
      .mockImplementation(async ({ sourceLanguage }: { sourceLanguage: string }) => {
        if (sourceLanguage === 'zh-CN') secondDetectionStarted.resolve(undefined);
        return 'available';
      });
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

  it('passes a detected Traditional Chinese script tag to the Translator API', async () => {
    const initialTranslator = makeTranslator('initial');
    const detectedTranslator = makeTranslator('detected');
    const create = vi
      .fn()
      .mockResolvedValueOnce(initialTranslator)
      .mockResolvedValueOnce(detectedTranslator);
    const availability = vi.fn().mockResolvedValue('available');
    stubTranslator(create, availability);

    const service = new TranslationService();
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ja' });
    await service.setDetectedSource('zh-Hant');

    expect(availability).toHaveBeenLastCalledWith({
      sourceLanguage: 'zh-Hant',
      targetLanguage: 'ja',
    });
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceLanguage: 'zh-Hant', targetLanguage: 'ja' })
    );
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
