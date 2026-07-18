import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranslatorInstance } from '@platform/translation-adapter';
import { TranslationService } from '@translation/service';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

    create.mockImplementationOnce(() => newCreation.promise);
    const replacement = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    await flushMicrotasks();

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

    create.mockImplementationOnce(() => newCreation.promise);
    const replacement = service.configure({
      enabled: true,
      service: 'auto',
      source: 'en',
      target: 'ko',
    });
    await flushMicrotasks();

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
    await flushMicrotasks();
    expect(oldTranslator.translate).toHaveBeenCalledWith('in-flight');

    const queued = service.translate('queued');
    await service.configure({ enabled: true, service: 'auto', source: 'en', target: 'ko' });

    staleTranslation.resolve('stale result');
    await expect(inFlight).resolves.toBeNull();
    await expect(queued).resolves.toBeNull();
    expect(newTranslator.translate).not.toHaveBeenCalled();

    service.destroy();
  });
});
