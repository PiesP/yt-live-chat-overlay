// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, BrowserContext, Route } from '@playwright/test';

import { restoreFixtureSettings } from './fixture-settings.ts';
import { installNativePageScriptProbe } from './native-page-script-probe.ts';

const URL = 'https://www.youtube.com/watch?v=windowsOpacityDomains';
const KEY = 'yt-live-chat-overlay-settings';
const ENTRY = '\n\tmain();\n';

function readSettings() {
  const app = window.__ytChatOverlay;
  if (!app) throw new Error('Opacity fixture app is unavailable');
  return app.getSettings();
}

declare global {
  interface Window {
    __ytOpacityProof?: { main: number[]; worker: number[]; overflow: number };
  }
}

/** Observe the production configuration owners without changing their results. */
export function observeOpacitySource(source: string): string {
  assert.equal(source.split(ENTRY).length, 2, 'Production entry shape changed');
  assert(source.includes('var CanvasRenderer = class CanvasRenderer'));
  return source.replace(
    ENTRY,
    '\n\tconst originalOpacityUpdate = CanvasRenderer.prototype.updateSettings;\n' +
      '\tCanvasRenderer.prototype.updateSettings = function(settings, ...args) {\n' +
      '\t\tconst proof = window.__ytOpacityProof;\n' +
      '\t\tif (proof) { if (proof.main.length < 128) proof.main.push(settings.outline.opacity); else proof.overflow++; }\n' +
      '\t\treturn originalOpacityUpdate.call(this, settings, ...args);\n' +
      `\t};${ENTRY}`
  );
}

/** One bounded settings flow; media and chat are controlled fixture prerequisites. */
export async function runOpacityDomains({
  browser,
  root,
  output,
  userscript,
  watchHtml,
  installedContext,
  installedExtensionId,
}: {
  browser: Browser;
  root: string;
  output: string;
  userscript: string;
  watchHtml: string;
  installedContext?: BrowserContext | undefined;
  installedExtensionId?: string | undefined;
}) {
  const context = installedContext ?? (await browser.newContext({ locale: 'en-US' }));
  const page = await context.newPage();
  const errors: string[] = [];
  let overflow = 0;
  page.on('pageerror', (error) => {
    if (errors.length < 16) errors.push(error.message.slice(0, 200));
    else overflow++;
  });
  page.on('console', (entry) => {
    if (entry.type() !== 'error') return;
    if (errors.length < 16) errors.push(entry.text().slice(0, 200));
    else overflow++;
  });
  const source = installedContext
    ? await readFile(join(root, 'dist-extension/page-script.js'), 'utf8')
    : userscript;
  const observed = observeOpacitySource(source);
  let probe: Awaited<ReturnType<typeof installNativePageScriptProbe>> | undefined;
  let previous: ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']> | undefined;
  let failure: unknown;
  let result: Record<string, unknown> = { status: 'failed' };
  const cleanup: Record<string, unknown> = {};
  const route = async (request: Route) => {
    const url = new globalThis.URL(request.request().url());
    if (url.protocol === 'chrome-extension:') return request.continue();
    if (url.href === URL && request.request().resourceType() === 'document')
      return request.fulfill({ contentType: 'text/html', body: watchHtml });
    if (url.origin === 'https://www.youtube.com' && url.pathname.includes('/live_chat/'))
      return request.fulfill({
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                { timedContinuationData: { continuation: 'opacity-next', timeoutMs: 30_000 } },
              ],
            },
          },
        },
      });
    return request.fulfill({ status: 204 });
  };
  try {
    await page.route('**/*', route);
    await page.addInitScript(() => {
      window.__ytOpacityProof = { main: [], worker: [], overflow: 0 };
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => false,
      });
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-opacity-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsOpacityDomains' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  { timedContinuationData: { continuation: 'opacity-initial', timeoutMs: 30_000 } },
                ],
              },
            },
          },
        },
      };
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions
      ) {
        const value = (message as { config?: { outlineOpacity?: number } })?.config?.outlineOpacity;
        const proof = window.__ytOpacityProof;
        if (proof && typeof value === 'number') {
          if (proof.worker.length < 128) proof.worker.push(value);
          else proof.overflow++;
        }
        return Reflect.apply(post, this, [message, options]);
      };
    });
    if (installedContext) {
      assert(installedExtensionId);
      probe = await installNativePageScriptProbe({
        context,
        root,
        extensionId: installedExtensionId,
        fixtureUrl: URL,
        instrumentedSource: observed,
      });
      await probe.assertReady();
    } else {
      await page.addInitScript(
        ({ key }) => {
          window.GM_getValue = (name: string, fallback?: string) =>
            localStorage.getItem(name) ?? fallback;
          window.GM_setValue = (name: string, value: string) => localStorage.setItem(name, value);
          window.GM_addValueChangeListener = () => 1;
          window.GM_removeValueChangeListener = () => {};
          localStorage.setItem(key, localStorage.getItem(key) ?? '{"language":"en"}');
        },
        { key: KEY }
      );
      await page.addInitScript({ content: observed });
    }
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ytChatOverlay);
    await probe?.assertInjected();
    previous = await page.evaluate(readSettings);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const open = async () => {
      await page.locator('#movie_player').hover();
      await page.locator('#yt-chat-overlay-settings-button').click();
      const modal = page.locator('#yt-chat-overlay-settings-backdrop');
      await modal.waitFor({ state: 'visible' });
      return modal;
    };
    let modal = await open();
    const attributes: Record<string, string[]> = {};
    for (const [name, min, step] of [
      ['opacity', '50', '5'],
      ['outline-opacity', '0', '10'],
    ]) {
      for (const suffix of ['', '-slider']) {
        const input = modal.locator(`input[name="${name}${suffix}"]`);
        const actual = await input.evaluate((element) => [
          element.getAttribute('min'),
          element.getAttribute('max'),
          element.getAttribute('step'),
        ]);
        assert.deepEqual(actual, [min, '100', step]);
        attributes[`${name}${suffix}`] = actual as string[];
      }
    }
    await modal.locator('#tab-colors').click();
    await modal.locator('input[name="outline-enabled"]').check();
    await modal.locator('input[name="outline-opacity"]').fill('20');
    await page.waitForFunction(
      () =>
        window.__ytChatOverlay?.getSettings().outline.opacity === 0.2 &&
        window.__ytOpacityProof?.main.includes(0.2)
    );
    if (installedContext)
      await page.waitForFunction(() => window.__ytOpacityProof?.worker.includes(0.2));
    await modal.locator('input[name="outline-enabled"]').uncheck();
    await page.waitForFunction(
      () => window.__ytChatOverlay?.getSettings().outline.enabled === false
    );
    assert.equal(await modal.locator('input[name="outline-opacity"]').inputValue(), '20');
    await modal.locator('input[name="outline-enabled"]').check();
    await page.waitForFunction(
      () => window.__ytChatOverlay?.getSettings().outline.enabled === true
    );
    await page.screenshot({ path: join(output, 'opacity-preview-20.png') });
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      await window.__ytChatOverlay?.stop();
    });
    const previewProof = await page.evaluate(() => window.__ytOpacityProof);
    // The native probe admits exactly one document. Reload the real packaged
    // source after observing that first injection, retaining its separate proof.
    await probe?.restore();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings().outline.opacity === 0.2);
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), timeOrigin);
    modal = await open();
    await modal.locator('#tab-colors').click();
    assert.equal(await modal.locator('input[name="outline-opacity"]').inputValue(), '20');
    await modal.locator('input[name="outline-opacity"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, 'opacity-reloaded-20.png') });
    await modal.locator('#tab-comments').click();
    await modal.locator('input[name="opacity"]').fill('20');
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings().opacity === 0.5);
    assert.equal(await modal.locator('input[name="opacity"]').inputValue(), '50');
    await page.keyboard.press('Escape');
    const settings = await page.evaluate(readSettings);
    assert.equal(settings.outline.opacity, 0.2);
    const proof = await page.evaluate(() => window.__ytOpacityProof);
    assert(proof && proof.overflow === 0);
    assert.deepEqual(errors, []);
    assert.equal(overflow, 0);
    result = {
      status: 'passed',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      observedSha256: createHash('sha256').update(observed).digest('hex'),
      attributes,
      initialTimeOrigin: timeOrigin,
      freshTimeOrigin: await page.evaluate(() => performance.timeOrigin),
      settings: { opacity: settings.opacity, outline: settings.outline },
      previewProof,
      proof,
      scope: installedContext
        ? 'installed extension / controlled Worker fixture'
        : 'built userscript / controlled Main fixture',
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (installedExtensionId && previous)
        await restoreFixtureSettings(context, page, installedExtensionId, previous);
      else
        await page.evaluate(async () => {
          await window.__ytChatOverlay?.stop();
        });
      cleanup.settingsRestored =
        installedExtensionId && previous ? true : 'not-applicable-owned-context';
    } catch (error) {
      cleanup.error = String(error);
      failure ??= error;
    }
    try {
      await probe?.restore();
      cleanup.probeRetired = true;
    } catch (error) {
      cleanup.probeError = String(error);
      failure ??= error;
    }
    await page.close().catch((error) => {
      failure ??= error;
      cleanup.pageCloseError = String(error);
    });
    if (!installedContext)
      await context.close().catch((error) => {
        failure ??= error;
        cleanup.contextCloseError = String(error);
      });
    await writeFile(
      join(output, 'opacity-domains.json'),
      JSON.stringify(
        { ...result, cleanup, errors, overflow, failure: failure ? String(failure) : null },
        null,
        2
      )
    );
  }
  if (failure) throw failure;
  return { checks: { opacityDomains: true, sustainedViewingLifecycle: false }, ...result, cleanup };
}
