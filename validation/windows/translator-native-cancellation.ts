// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext } from '@playwright/test';

export const TRANSLATOR_NATIVE_URL = 'https://www.youtube.com/watch?v=windowsTranslatorNative';
const SELECTOR = 'validation/windows/inputs/translator-native-cancellation.json';
const OPERATION_DEADLINE_MS = 15_000;
const SETUP_DEADLINE_MS = 120_000;
const LONG_TEXT =
  'The station display says the next train will arrive soon. Please keep this message short and clear for a traveler. 안녕하세요 東京. '.repeat(
    48
  );
type Action =
  | 'preaborted-create'
  | 'create'
  | 'preaborted-translate'
  | 'mid-translate-abort'
  | 'same-object-translate'
  | 'destroy-pending';
type Settlement = 'fulfilled' | 'rejected' | 'unknown';
export type NativeProbeSelection = {
  case: 'normal' | 'preaborted-create';
  realm: 'isolated' | 'main';
};
export type CaseResult = {
  action: Action;
  settlement: Settlement;
  elapsedMs: number;
  errorName: string | null;
  output: { codepoints: number; sha256: string } | null;
  input: { codepoints: number; sha256: string } | null;
  userActivationAtClick?: boolean | null;
  abortRequestedMs?: number | null;
  destroyCalledMs?: number | null;
  unsettledAtDestroy?: boolean | null;
  postdestroy?: {
    settlement: Settlement;
    errorName: string | null;
    input?: { codepoints: number; sha256: string };
    output?: { codepoints: number; sha256: string } | null;
  };
};

export function canContinueNativeProbe(result: Pick<CaseResult, 'settlement'>): boolean {
  return result.settlement !== 'unknown';
}

export function classifyNativeCase(
  result: CaseResult
): 'expected-js-settlement' | 'ignored' | 'inconclusive' {
  if (result.settlement === 'unknown') return 'inconclusive';
  if (
    (result.action === 'create' || result.action === 'preaborted-create') &&
    result.userActivationAtClick !== true
  )
    return 'inconclusive';
  if (result.action === 'preaborted-create' || result.action === 'preaborted-translate') {
    if (result.settlement === 'fulfilled') return 'ignored';
    return result.errorName === 'AbortError' ? 'expected-js-settlement' : 'inconclusive';
  }
  if (result.action === 'mid-translate-abort') {
    if (
      result.abortRequestedMs === null ||
      result.abortRequestedMs === undefined ||
      result.abortRequestedMs >= result.elapsedMs
    )
      return 'inconclusive';
    if (result.settlement === 'fulfilled') return 'ignored';
    return result.errorName === 'AbortError' ? 'expected-js-settlement' : 'inconclusive';
  }
  if (result.action === 'destroy-pending') {
    if (
      result.destroyCalledMs === null ||
      result.destroyCalledMs === undefined ||
      result.destroyCalledMs >= result.elapsedMs ||
      result.unsettledAtDestroy !== true
    )
      return 'inconclusive';
    if (result.settlement === 'fulfilled' || result.postdestroy?.settlement === 'fulfilled')
      return 'ignored';
    return result.settlement === 'rejected' &&
      result.errorName === 'AbortError' &&
      result.postdestroy?.settlement === 'rejected' &&
      result.postdestroy.errorName === 'AbortError'
      ? 'expected-js-settlement'
      : 'inconclusive';
  }
  if (result.action === 'same-object-translate') {
    return result.settlement === 'fulfilled' &&
      (result.output?.codepoints ?? 0) > 0 &&
      /^[a-f0-9]{64}$/u.test(result.output?.sha256 ?? '')
      ? 'expected-js-settlement'
      : 'inconclusive';
  }
  return result.settlement === 'fulfilled' ? 'expected-js-settlement' : 'inconclusive';
}

export function parseTranslatorNativeSelector(input: unknown): NativeProbeSelection {
  for (const realm of ['isolated', 'main'] as const) {
    for (const probeCase of ['normal', 'preaborted-create'] as const) {
      const expected = {
        scenario: 'translator-native-cancellation',
        ...(probeCase === 'preaborted-create' ? { case: probeCase } : {}),
        ...(realm === 'main' ? { realm } : {}),
      };
      if (JSON.stringify(input) === JSON.stringify(expected)) return { case: probeCase, realm };
    }
  }
  assert.fail('Native Translator selector must match an exact supported case and realm');
}

export async function readTranslatorNativeSelector(
  root: string
): Promise<NativeProbeSelection | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, SELECTOR), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseTranslatorNativeSelector(JSON.parse(raw) as unknown);
}

export function installNativeProbe({
  longText,
  operationDeadlineMs,
  setupDeadlineMs,
}: {
  longText: string;
  operationDeadlineMs: number;
  setupDeadlineMs: number;
}) {
  type TranslatorInstance = {
    translate: (input: string, options?: { signal?: AbortSignal }) => Promise<string>;
    destroy: () => void;
  };
  type NativeApi = {
    availability: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
    create: (options: {
      sourceLanguage: string;
      targetLanguage: string;
      signal?: AbortSignal;
    }) => Promise<TranslatorInstance>;
  };
  const button = document.querySelector<HTMLButtonElement>('#probe');
  if (!button) throw new Error('NativeProbeButtonMissing');
  const state = { translator: null as TranslatorInstance | null };
  const api = (globalThis as unknown as { Translator?: NativeApi }).Translator;
  const pair = { sourceLanguage: 'en', targetLanguage: 'ja' };
  const digest = async (value: string) => ({
    codepoints: Array.from(value).length,
    sha256: Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join(''),
  });
  const errorName = (error: unknown) =>
    error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : typeof error;
  const observe = async (
    promise: Promise<unknown>,
    limitMs: number,
    operationStarted = performance.now()
  ) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.resolve(promise).then(
      (value) => ({
        settlement: 'fulfilled' as const,
        elapsedMs: performance.now() - operationStarted,
        value,
        errorName: null,
      }),
      (error: unknown) => ({
        settlement: 'rejected' as const,
        elapsedMs: performance.now() - operationStarted,
        value: null,
        errorName: errorName(error),
      })
    );
    const deadline = new Promise<{
      settlement: 'unknown';
      elapsedMs: number;
      value: null;
      errorName: null;
    }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            settlement: 'unknown',
            elapsedMs: performance.now() - operationStarted,
            value: null,
            errorName: null,
          }),
        limitMs
      );
    });
    const observation = await Promise.race([settled, deadline]);
    if (timer) clearTimeout(timer);
    return observation;
  };
  button.addEventListener('click', () => {
    const action = button.dataset.action ?? null;
    const userActivationAtClick = navigator.userActivation?.isActive ?? null;
    void (async () => {
      if (!api || action === null)
        return { action, settlement: 'rejected', errorName: 'TranslatorUnavailable' };
      const started = performance.now();
      if (action === 'availability') {
        const observation = await observe(api.availability(pair), operationDeadlineMs);
        return { action, ...observation, value: observation.value, userActivationAtClick };
      }
      const input =
        action === 'mid-translate-abort' || action === 'destroy-pending'
          ? longText
          : 'Please meet me at the station. 안녕하세요 東京.';
      const inputSummary =
        action.includes('translate') || action === 'destroy-pending' ? await digest(input) : null;
      const controller = new AbortController();
      if (action.startsWith('preaborted')) controller.abort();
      let promise: Promise<unknown>;
      try {
        if (action === 'preaborted-create' || action === 'create') {
          promise = api.create({
            ...pair,
            ...(action === 'preaborted-create' ? { signal: controller.signal } : {}),
          });
        } else {
          if (!state.translator) throw new Error('NoTranslator');
          promise = state.translator.translate(
            input,
            action === 'preaborted-translate' || action === 'mid-translate-abort'
              ? { signal: controller.signal }
              : undefined
          );
        }
      } catch (error) {
        return {
          action,
          settlement: 'rejected',
          elapsedMs: performance.now() - started,
          errorName: errorName(error),
          output: null,
          input: inputSummary,
          userActivationAtClick,
        };
      }
      let abortRequestedMs: number | null = null;
      let destroyCalledMs: number | null = null;
      let unsettledAtDestroy: boolean | null = null;
      if (action === 'mid-translate-abort') {
        setTimeout(() => {
          abortRequestedMs = performance.now() - started;
          controller.abort();
        }, 1);
      }
      if (action === 'destroy-pending') {
        let settled = false;
        void promise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        unsettledAtDestroy = !settled;
        if (unsettledAtDestroy) {
          destroyCalledMs = performance.now() - started;
          state.translator?.destroy();
        }
      }
      const observation = await observe(
        promise,
        action === 'create' ? setupDeadlineMs : operationDeadlineMs,
        started
      );
      if (action === 'create' && observation.settlement === 'fulfilled')
        state.translator = observation.value as TranslatorInstance;
      if (action === 'preaborted-create' && observation.settlement === 'fulfilled')
        (observation.value as TranslatorInstance).destroy();
      const output = typeof observation.value === 'string' ? await digest(observation.value) : null;
      let postdestroy:
        | {
            settlement: string;
            errorName: string | null;
            input: { codepoints: number; sha256: string };
            output: { codepoints: number; sha256: string } | null;
          }
        | undefined;
      if (
        action === 'destroy-pending' &&
        destroyCalledMs !== null &&
        observation.settlement !== 'unknown'
      ) {
        const postdestroyInput = 'Hello after destroy.';
        const postdestroyInputSummary = await digest(postdestroyInput);
        try {
          if (!state.translator) throw new Error('NoTranslatorAfterDestroy');
          const after = await observe(
            state.translator.translate(postdestroyInput),
            operationDeadlineMs
          );
          postdestroy = {
            settlement: after.settlement,
            errorName: after.errorName,
            input: postdestroyInputSummary,
            output: typeof after.value === 'string' ? await digest(after.value) : null,
          };
        } catch (error) {
          postdestroy = {
            settlement: 'rejected',
            errorName: errorName(error),
            input: postdestroyInputSummary,
            output: null,
          };
        }
        state.translator = null;
      }
      return {
        action,
        settlement: observation.settlement,
        elapsedMs: observation.elapsedMs,
        errorName: observation.errorName,
        output,
        input: inputSummary,
        abortRequestedMs,
        destroyCalledMs,
        unsettledAtDestroy,
        userActivationAtClick,
        ...(postdestroy ? { postdestroy } : {}),
      };
    })().then(
      (result) => {
        button.dataset.result = JSON.stringify(result);
      },
      (error: unknown) => {
        button.dataset.result = JSON.stringify({
          action,
          settlement: 'rejected',
          errorName: errorName(error),
        });
      }
    );
  });
  const extensionRuntimeId =
    (globalThis as unknown as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id ??
    null;
  return {
    secureContext: isSecureContext,
    origin: location.origin,
    href: location.href,
    topLevel: window.top === window,
    userAgent: navigator.userAgent,
    realm: extensionRuntimeId === null ? 'main-page' : 'extension-isolated-content-script',
    extensionId: extensionRuntimeId,
    apiType: typeof api,
    availabilityType: typeof api?.availability,
    createType: typeof api?.create,
  };
}

/** Observe browser-native promises without interpreting an observation deadline as cancellation. */
export async function runTranslatorNativeCancellation({
  context,
  extensionId,
  browserVersion,
  selection,
}: {
  context: BrowserContext;
  extensionId: string;
  browserVersion: string;
  selection: NativeProbeSelection;
}) {
  assert.match(extensionId, /^[a-p]{32}$/u);
  const page = await context.newPage();
  const receipt: {
    source: string;
    browserVersion: string;
    installedExtensionId: string;
    selection: NativeProbeSelection;
    url: string;
    mainPageContext: unknown;
    injection: {
      requestedWorld: 'ISOLATED' | 'MAIN';
      tabId: number;
      tabUrl: string;
      frameId: number;
      documentId: string;
    } | null;
    capability: unknown;
    availability: unknown;
    cases: CaseResult[];
    caseVerdicts: Array<{ action: Action; verdict: ReturnType<typeof classifyNativeCase> }>;
    status: 'observed' | 'unsupported' | 'inconclusive';
    reason: string;
    pageClosed: boolean;
  } = {
    source:
      selection.realm === 'main'
        ? 'installed-extension-owned-secure-origin-main-page-realm'
        : 'installed-extension-owned-secure-origin-isolated-content-script-realm',
    browserVersion,
    installedExtensionId: extensionId,
    selection,
    url: TRANSLATOR_NATIVE_URL,
    mainPageContext: null,
    injection: null,
    capability: null,
    availability: null,
    cases: [],
    caseVerdicts: [],
    status: 'inconclusive',
    reason: 'not-started',
    pageClosed: false,
  };
  let stage = 'fixture-navigation';
  try {
    await page.route('**/*', async (route) => {
      if (route.request().url().startsWith(`chrome-extension://${extensionId}/`)) {
        await route.continue();
      } else if (
        route.request().url() === TRANSLATOR_NATIVE_URL &&
        route.request().isNavigationRequest()
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Native Translator probe</title><button id="probe" type="button">Run native case</button></html>',
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    });
    await page.goto(TRANSLATOR_NATIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    stage = 'extension-realm-injection';
    receipt.mainPageContext = await page.evaluate(() => ({
      realm: 'main-page',
      secureContext: isSecureContext,
      origin: location.origin,
      href: location.href,
      apiType: typeof (globalThis as unknown as { Translator?: unknown }).Translator,
    }));
    const expectedWorkerUrl = `chrome-extension://${extensionId}/background.js`;
    const worker =
      context.serviceWorkers().find((entry) => entry.url() === expectedWorkerUrl) ??
      (await context.waitForEvent('serviceworker', {
        predicate: (entry) => entry.url() === expectedWorkerUrl,
        timeout: 10_000,
      }));
    const tabs = await worker.evaluate<Array<{ id?: number; url?: string }>>(
      `chrome.tabs.query({ url: ${JSON.stringify(TRANSLATOR_NATIVE_URL)} })`
    );
    assert.equal(tabs.length, 1, 'Owned fixture tab was not found by installed extension');
    const tabId = tabs[0]?.id;
    const tabUrl = tabs[0]?.url;
    assert(
      typeof tabId === 'number' && Number.isSafeInteger(tabId),
      'Owned fixture tab ID is unavailable'
    );
    assert(tabUrl === TRANSLATOR_NATIVE_URL, 'Owned fixture tab URL changed');
    assert.equal(page.url(), TRANSLATOR_NATIVE_URL, 'Owned fixture page URL changed');
    const requestedWorld = selection.realm === 'main' ? 'MAIN' : 'ISOLATED';
    const injected = await worker.evaluate<
      Array<{ result: unknown; frameId: number; documentId?: string }>
    >(
      `chrome.scripting.executeScript({
        target: { tabId: ${tabId} },
        world: '${requestedWorld}',
        func: ${installNativeProbe.toString()},
        args: [${JSON.stringify({ longText: LONG_TEXT, operationDeadlineMs: OPERATION_DEADLINE_MS, setupDeadlineMs: SETUP_DEADLINE_MS })}],
      })`
    );
    assert.equal(injected.length, 1, 'Native probe injection must target one document');
    const injection = injected[0];
    assert(injection, 'Native probe injection result is missing');
    assert.equal(injection.frameId, 0, 'Native probe injection missed the top frame');
    assert(injection.documentId, 'Native probe injection document ID is missing');
    receipt.injection = {
      requestedWorld,
      tabId,
      tabUrl,
      frameId: injection.frameId,
      documentId: injection.documentId,
    };
    receipt.capability = injection.result ?? null;
    const runAction = async (action: Action | 'availability') => {
      stage = action;
      await page.locator('#probe').evaluate((button, next) => {
        button.setAttribute('data-action', next);
        button.removeAttribute('data-result');
      }, action);
      await page.locator('#probe').click();
      await page.waitForFunction(
        () => document.querySelector('#probe')?.hasAttribute('data-result') === true,
        null,
        {
          timeout:
            action === 'create' ? SETUP_DEADLINE_MS + 10_000 : OPERATION_DEADLINE_MS + 10_000,
        }
      );
      const raw = await page.locator('#probe').getAttribute('data-result');
      assert(raw, 'Native case result is missing');
      return JSON.parse(raw) as unknown;
    };
    const capability = receipt.capability as {
      realm: string;
      createType: string;
      availabilityType: string;
      extensionId: string | null;
      href: string;
      origin: string;
      secureContext: boolean;
      topLevel: boolean;
    };
    const expectedRealm =
      selection.realm === 'main' ? 'main-page' : 'extension-isolated-content-script';
    const expectedRuntimeId = selection.realm === 'main' ? null : extensionId;
    if (
      capability.realm !== expectedRealm ||
      capability.extensionId !== expectedRuntimeId ||
      capability.href !== TRANSLATOR_NATIVE_URL ||
      capability.origin !== 'https://www.youtube.com' ||
      capability.secureContext !== true ||
      capability.topLevel !== true
    ) {
      receipt.reason = `extension-${selection.realm}-realm-or-document-mismatch`;
      return receipt;
    }
    if (capability.createType !== 'function' || capability.availabilityType !== 'function') {
      receipt.status = 'unsupported';
      receipt.reason = 'translator-api-methods-unavailable';
      return receipt;
    }
    receipt.availability = await runAction('availability');
    const availability = receipt.availability as { settlement: Settlement; value?: unknown };
    if (availability.settlement !== 'fulfilled') {
      receipt.reason = 'availability-not-observed';
      return receipt;
    }
    if (
      availability.value !== 'available' &&
      availability.value !== 'downloadable' &&
      availability.value !== 'downloading'
    ) {
      receipt.status = 'unsupported';
      receipt.reason = 'language-pair-unavailable';
      return receipt;
    }
    const actions: Action[] =
      selection.case === 'preaborted-create'
        ? ['preaborted-create']
        : [
            'create',
            'preaborted-translate',
            'mid-translate-abort',
            'same-object-translate',
            'destroy-pending',
          ];
    for (const action of actions) {
      const result = (await runAction(action)) as CaseResult;
      receipt.cases.push(result);
      receipt.caseVerdicts.push({ action, verdict: classifyNativeCase(result) });
      if (!canContinueNativeProbe(result)) {
        receipt.reason = `${action}-native-settlement-unknown`;
        return receipt;
      }
      if (action === 'create' && result.settlement !== 'fulfilled') {
        receipt.reason = 'model-setup-did-not-complete';
        return receipt;
      }
    }
    receipt.status = receipt.caseVerdicts.every(
      (entry) => entry.verdict === 'expected-js-settlement'
    )
      ? 'observed'
      : 'inconclusive';
    receipt.reason =
      receipt.status === 'observed'
        ? 'all-native-cases-observed-with-expected-settlement'
        : 'native-case-ignored-or-inconclusive';
    return receipt;
  } catch (error) {
    receipt.status = 'inconclusive';
    receipt.reason = `${stage}:${error instanceof Error ? error.name : typeof error}`;
    return receipt;
  } finally {
    try {
      await page.close();
      receipt.pageClosed = true;
    } catch {
      receipt.status = 'inconclusive';
      receipt.reason = 'owned-fixture-page-close-failed';
    }
  }
}
