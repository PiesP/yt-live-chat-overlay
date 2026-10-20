// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type {
  BrowserContext,
  BrowserType,
  CDPSession,
  Page,
  Request,
  Response,
} from '@playwright/test';

import { runBitmapLifecycleFixture } from './bitmap-lifecycle.ts';
import type { ChromeProcessIdentity } from './chrome-process.ts';
import { captureOwnedChromeProcess, terminateOwnedChromeProcess } from './chrome-process.ts';
import {
  assessPublicImage,
  assessPublicResize,
  countUnexpectedLiveErrors,
  installPublicImageDrawProbe,
  isPublicImageUrl,
  isYouTubeHostError,
  readPublicCanvasFrame,
  readPublicPageBrowserState,
  redactDiagnosticText,
  selectPublicSeekTarget,
  validateLiveRenderer,
} from './live-rendering.ts';
import type { PublicImageDraw, PublicImageResponse } from './live-rendering.ts';
import { runPlacementTimingFixture } from './placement-timing.ts';
import { run as runFixture } from './profile.ts';
import { loadUpgradeInputs, runManagerUpgrade } from './release-upgrade/upgrade.ts';

export { selectPublicSeekTarget };

const SCRIPT_NAME = 'YouTube Live Chat Overlay';
const CHROME_PROFILE_PREFIX = 'chrome-install-';
const GRACEFUL_PROCESS_EXIT_MS = 2_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const RESOURCE_BODY_TIMEOUT_MS = 3_000;
const RESOURCE_REQUEST_LIMIT = 16;
const OWNED_EXTENSION_RESOURCES = {
  'workers/renderer.js': 524_288,
  'page-script.js': 2_097_152,
};
type ExpectedResource = { maxBytes: number; bytes: number; sha256: string };
type ResourceEntry = {
  path: string;
  sourcePhase?: string | undefined;
  navigation?: string | undefined;
  documentUrl: string | null;
  documentUrlSha256: string | null;
  status: string;
  reason: string | null;
  responseStatus: number | null;
  mime: string | null;
  expectedBytes: number;
  expectedSha256: string;
  bytes?: number;
  sha256?: string;
};
type WorkflowStep = {
  status: string;
  kind?: string;
  reason?: string | null;
  [key: string]: unknown;
};
type LiveObservation = {
  url: string;
  status: string;
  mocked: boolean;
  phase?: string;
  screenshot?: string;
  finalUrl?: string;
  title?: string;
  video?: unknown;
  fontSize?: number;
  renderedMessages?: number;
  canvasAttached?: boolean;
  renderer?: string;
  extensionBridge?: unknown;
  installedBridgeReady?: boolean;
  chatMode?: string;
  provider?: Awaited<ReturnType<typeof readPublicPageState>>;
  workflow?: Record<string, WorkflowStep>;
  reason?: string;
  extensionResources?: unknown;
  workerDiagnostics?: unknown[];
  pageErrorTypes?: string[];
  unexpectedConsoleErrors?: number;
  hostConsoleErrors?: number;
  consoleErrors?: unknown[];
  workerPolicyFallback?: boolean;
  [key: string]: unknown;
};
type UpgradeResult =
  | (Awaited<ReturnType<typeof runManagerUpgrade>> & { effectiveGrantEvidence?: unknown })
  | { status: string };
type ChromeResult<Live = LiveObservation> = {
  installation: string;
  fixture: Awaited<ReturnType<typeof runFixture>> | null;
  placementTiming?: Awaited<ReturnType<typeof runPlacementTimingFixture>> | null;
  bitmapLifecycle?: Awaited<ReturnType<typeof runBitmapLifecycleFixture>> | null;
  userscriptUpgrade?: UpgradeResult | null;
  live: Live[];
  liveWorkflowCoverage?: {
    observedModes: (string | undefined)[];
    crossWatch: boolean;
    status: string;
  } | null;
  liveObservation?: { mode: 'duration'; duration_seconds: 1200 } | null;
  cleanup: Record<string, unknown>;
  browserVersion?: string;
  installationMethod?: string;
  userscriptManager?: unknown;
  naturalChrome?: unknown;
};
type CleanupOptions = {
  context?:
    | BrowserContext
    | { close: () => Promise<unknown>; browser?: () => { close: () => Promise<unknown> } }
    | undefined;
  cdp?:
    | { send: (method: 'Extensions.uninstall', params: { id: string }) => Promise<unknown> }
    | null
    | undefined;
  extensionId?: string | null | undefined;
  profile: string;
  output: string;
  result: { cleanup: Record<string, unknown> };
  browserProcessId?: number | undefined;
  browserProcessIdentity?: ChromeProcessIdentity | undefined;
  root: string;
};
type ChromeOptions = {
  chromium: BrowserType;
  root: string;
  output: string;
  browserName?: 'chrome' | 'msedge';
  headless?: boolean;
  installation: 'extension' | 'userscript';
  liveUrls?: string[];
  liveObservation?: { mode: 'duration'; duration_seconds: 1200 } | null;
};

export function ownedExtensionResourcePath(value: string, extensionId: string) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId)) return null;
  try {
    const url = new URL(value);
    const path = url.pathname.slice(1);
    return url.protocol === 'chrome-extension:' &&
      url.hostname === extensionId &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      Object.hasOwn(OWNED_EXTENSION_RESOURCES, path)
      ? path
      : null;
  } catch {
    return null;
  }
}

export function compareOwnedExtensionResourceBody(body: unknown, expected: ExpectedResource) {
  if (!Buffer.isBuffer(body) || body.length > expected.maxBytes) {
    return { status: 'unverified', reason: 'body-overflow' };
  }
  const sha256 = createHash('sha256').update(body).digest('hex');
  return {
    status: body.length === expected.bytes && sha256 === expected.sha256 ? 'matched' : 'unverified',
    reason: body.length === expected.bytes && sha256 === expected.sha256 ? null : 'body-mismatch',
    bytes: body.length,
    sha256,
  };
}

export async function readBoundedPackagedResource(
  file: string,
  label: string,
  maxBytes: number,
  { onOpened }: { onOpened?: () => Promise<void> } = {}
) {
  const flags =
    process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ELOOP')
      assert.fail(`Invalid packaged resource: ${label}`);
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assert(opened.isFile(), `Invalid packaged resource: ${label}`);
    assert(
      opened.size > 0n && opened.size <= BigInt(maxBytes),
      `Packaged ${label} exceeds diagnostic body limit or is empty`
    );
    await onOpened?.();
    const matchesOpened = (entry: BigIntStats) =>
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.dev === opened.dev &&
      entry.ino === opened.ino &&
      entry.size === opened.size &&
      entry.mtimeNs === opened.mtimeNs;
    const requirePathIdentity = async () => {
      let entry;
      try {
        entry = await lstat(file, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
          assert.fail(`Packaged ${label} changed during inspection`);
        throw error;
      }
      assert(matchesOpened(entry), `Packaged ${label} changed during inspection`);
    };
    await requirePathIdentity();
    const expectedBytes = Number(opened.size);
    const bounded = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.equal(offset, expectedBytes, `Packaged ${label} changed size while reading`);
    const after = await handle.stat({ bigint: true });
    assert(matchesOpened(after), `Packaged ${label} changed while reading`);
    await requirePathIdentity();
    return bounded.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readExpectedExtensionResources(root: string) {
  const expected: Record<string, ExpectedResource> = {};
  for (const [path, maxBytes] of Object.entries(OWNED_EXTENSION_RESOURCES)) {
    const body = await readBoundedPackagedResource(
      join(root, 'dist-extension', path),
      path,
      maxBytes
    );
    expected[path] = {
      maxBytes,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }
  return expected;
}

export function beginOwnedExtensionResourceCapture(
  page: Page,
  extensionId: string,
  expected: Record<string, ExpectedResource>,
  sourceContext: () => { sourcePhase?: string | undefined; navigation?: string | undefined }
) {
  const requests: ResourceEntry[] = [];
  const pending = new Set<Promise<void>>();
  const entries = new Map<Request, ResourceEntry>();
  let overflow = 0;
  const onRequest = (request: Request) => {
    const path = ownedExtensionResourcePath(request.url(), extensionId);
    if (!path) return;
    const resource = expected[path];
    assert(resource, 'Expected owned extension resource is missing');
    if (requests.length >= RESOURCE_REQUEST_LIMIT) {
      overflow++;
      return;
    }
    let documentUrl;
    let documentUrlSha256;
    try {
      const document = new URL(request.frame().url());
      documentUrl =
        document.protocol === 'https:' &&
        ['www.youtube.com', 'youtube.com'].includes(document.hostname) &&
        document.pathname === '/watch'
          ? `${document.origin}/watch`
          : null;
      documentUrlSha256 = createHash('sha256').update(document.href).digest('hex');
    } catch {
      documentUrl = null;
      documentUrlSha256 = null;
    }
    const entry = {
      path,
      ...sourceContext(),
      documentUrl,
      documentUrlSha256,
      status: 'unverified',
      reason: 'request-incomplete',
      responseStatus: null,
      mime: null,
      expectedBytes: resource.bytes,
      expectedSha256: resource.sha256,
    };
    requests.push(entry);
    entries.set(request, entry);
  };
  const recordResponse = (entry: ResourceEntry, response: Response) => {
    entry.responseStatus = response.status();
    const mime = response.headers()['content-type']?.split(';', 1)[0]?.trim();
    entry.mime = mime && /^[\w.+-]+\/[\w.+-]+$/u.test(mime) ? mime : null;
  };
  const onResponse = (response: Response) => {
    const entry = entries.get(response.request());
    if (entry) recordResponse(entry, response);
  };
  const onRequestFailed = (request: Request) => {
    const entry = entries.get(request);
    if (!entry) return;
    const failure = request.failure()?.errorText ?? '';
    entry.reason = /^net::ERR_[A-Z_]+$/u.test(failure) ? failure : 'request-failed';
    entries.delete(request);
  };
  const onRequestFinished = (request: Request) => {
    const entry = entries.get(request);
    if (!entry) return;
    const resource = expected[entry.path];
    assert(resource, 'Expected owned extension resource is missing');
    entries.delete(request);
    const inspect = (async () => {
      const response = await request.response();
      if (!response) {
        entry.reason = 'response-unavailable';
        return;
      }
      if (entry.responseStatus === null) recordResponse(entry, response);
      if (entry.responseStatus !== 200) {
        entry.reason = 'http-status';
        return;
      }
      const size = (await request.sizes()).responseBodySize;
      if (!Number.isSafeInteger(size) || size < 0) {
        entry.reason = 'body-size-unavailable';
        return;
      }
      if (size > resource.maxBytes) {
        entry.reason = 'body-overflow';
        return;
      }
      const contentLength = Number(response.headers()['content-length']);
      if (Number.isFinite(contentLength) && contentLength > resource.maxBytes) {
        entry.reason = 'body-overflow';
        return;
      }
      const body = await response.body();
      Object.assign(entry, compareOwnedExtensionResourceBody(body, resource));
    })().catch(() => {
      entry.reason = 'response-read-failed';
    });
    pending.add(inspect);
    void inspect.finally(() => pending.delete(inspect));
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.on('requestfinished', onRequestFinished);
  return async () => {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
    page.off('requestfinished', onRequestFinished);
    if (pending.size) {
      await Promise.race([Promise.allSettled([...pending]), delay(RESOURCE_BODY_TIMEOUT_MS)]);
    }
    const snapshot = requests.map((item) => ({ ...item }));
    const missing = Object.keys(expected).filter(
      (path) => !snapshot.some((item) => item.path === path)
    );
    const missingByNavigation = Object.fromEntries(
      ['initial-watch', 'next-watch'].map((navigation) => [
        navigation,
        Object.keys(expected).filter(
          (path) => !snapshot.some((item) => item.navigation === navigation && item.path === path)
        ),
      ])
    );
    return {
      status:
        overflow === 0 &&
        Object.values(missingByNavigation).every((paths) => paths.length === 0) &&
        snapshot.every((item) => item.status === 'matched')
          ? 'observed'
          : 'unverified',
      expected,
      missing,
      missingByNavigation,
      overflow,
      requests: snapshot,
    };
  };
}

async function readExtensionBridgeDiagnostic(page: Page) {
  return page.evaluate(() => {
    const bridge = (
      window as Window & {
        __ytExtensionBridge?: {
          workerUrl?: string;
          workerSupported?: boolean;
          storageType?: string;
        };
      }
    ).__ytExtensionBridge;
    const workerUrl = bridge?.workerUrl;
    let workerBlobOrigin = null;
    try {
      if (typeof workerUrl === 'string' && workerUrl.startsWith('blob:')) {
        workerBlobOrigin = new URL(workerUrl).origin;
      }
    } catch {
      // The origin remains unknown when the browser exposes an invalid URL.
    }
    return {
      workerSupported: bridge?.workerSupported === true,
      storageType: bridge?.storageType ?? null,
      workerBlobOrigin,
      documentOrigin: location.origin,
      workerUrlUsesDocumentOrigin:
        typeof workerUrl === 'string' && workerUrl.startsWith(`blob:${location.origin}/`),
    };
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assertOwnedProfile(root: string, profile: string) {
  const resolvedRoot = resolve(root);
  const resolvedProfile = resolve(profile);
  if (
    dirname(resolvedProfile) !== resolvedRoot ||
    !basename(resolvedProfile).startsWith(CHROME_PROFILE_PREFIX)
  ) {
    throw new Error('Refusing to remove a Chrome profile outside the task root');
  }
}

export function readOwnedBrowserProcessId(response: unknown): number {
  const processInfo =
    response && typeof response === 'object' && 'processInfo' in response
      ? response.processInfo
      : undefined;
  const browsers = Array.isArray(processInfo)
    ? processInfo.filter(
        (entry: unknown) =>
          entry && typeof entry === 'object' && 'type' in entry && entry.type === 'browser'
      )
    : [];
  if (browsers.length !== 1 || !Number.isSafeInteger(browsers[0]?.id) || browsers[0].id <= 0) {
    throw new Error('Browser CDP did not expose one task-owned browser process');
  }
  return browsers[0].id as number;
}

async function isProcessAlive(processId: number) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(
  processId: number,
  checkAlive: (processId: number) => Promise<boolean> = isProcessAlive,
  timeoutMs: number = PROCESS_EXIT_TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkAlive(processId))) return true;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return !(await checkAlive(processId));
}

export async function removeOwnedChromeProfile(root: string, profile: string) {
  assertOwnedProfile(root, profile);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const removed = await stat(profile).then(
    () => false,
    (error) => {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  );
  if (!removed) throw new Error('Task-owned Chrome profile remained after bounded cleanup');
}

export async function enableDeveloperMode(context: BrowserContext, browserName: string) {
  const page = await context.newPage();
  try {
    await page.goto(browserName === 'msedge' ? 'edge://extensions/' : 'chrome://extensions/');
    const toggle = page.locator(browserName === 'msedge' ? '#dev-switch:visible' : '#devMode');
    await toggle.waitFor({ state: 'visible' });
    if (
      !(await toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked))
    )
      await toggle.click();
    assert(
      await toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
      'Developer mode is disabled'
    );
  } finally {
    await page.close();
  }
}

export function isOwnedManagerOptionsUrl(value: string, managerId: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'chrome-extension:' &&
      url.hostname === managerId &&
      url.pathname === '/options.html' &&
      !url.search
    );
  } catch {
    return false;
  }
}

export function requireManagerUiLabels(labels: unknown) {
  assert(
    labels && typeof labels === 'object' && !Array.isArray(labels),
    'Manager returned invalid UI labels'
  );
  assert.deepEqual(
    Object.keys(labels).sort(),
    ['install', 'installedUserscripts', 'utilities'],
    'Manager UI label keys differ'
  );
  for (const value of Object.values(labels)) {
    assert(
      typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 80 &&
        value.trim() === value &&
        !/[\r\n\u0000-\u001f]/u.test(value),
      'Manager returned an invalid UI label'
    );
  }
  return labels as { utilities: string; install: string; installedUserscripts: string };
}

export async function readManagerUiLabels(page: Page, managerId: string) {
  assert(
    isOwnedManagerOptionsUrl(page.url(), managerId),
    'Manager labels require its owned options page'
  );
  const labels = await page.evaluate((expectedId) => {
    const url = new URL(location.href);
    if (
      url.protocol !== 'chrome-extension:' ||
      url.hostname !== expectedId ||
      url.pathname !== '/options.html' ||
      url.search
    ) {
      throw new Error('Manager options page navigated away');
    }
    return {
      utilities: (
        globalThis as typeof globalThis & {
          chrome: { i18n: { getMessage: (key: string) => string } };
        }
      ).chrome.i18n.getMessage('Utilities'),
      install: (
        globalThis as typeof globalThis & {
          chrome: { i18n: { getMessage: (key: string) => string } };
        }
      ).chrome.i18n.getMessage('Install'),
      installedUserscripts: (
        globalThis as typeof globalThis & {
          chrome: { i18n: { getMessage: (key: string) => string } };
        }
      ).chrome.i18n.getMessage('Installed_userscripts'),
    };
  }, managerId);
  assert(
    isOwnedManagerOptionsUrl(page.url(), managerId),
    'Manager options page navigated away after label lookup'
  );
  return requireManagerUiLabels(labels);
}

async function prepareUserscriptManager(context: BrowserContext, id: string, root: string) {
  const managerRoot = join(root, 'test-tools/userscript-manager');
  const managerManifest = JSON.parse(await readFile(join(managerRoot, 'manifest.json'), 'utf8'));
  assert.equal(managerManifest.version, '5.5.1', 'Unexpected userscript manager version');
  const page = await context.newPage();
  try {
    await page.goto(`chrome://extensions/?id=${id}`);
    const toggle = page.locator('#allow-user-scripts cr-toggle');
    await toggle.waitFor({ state: 'visible' });
    if (
      !(await toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked))
    )
      await toggle.click();
    assert(
      await toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
      'User scripts permission is disabled'
    );
    const keep = page.getByRole('button', { name: 'Keep', exact: true });
    if (await keep.isVisible()) await keep.click();
    const restarted = context.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().startsWith(`chrome-extension://${id}/`),
      timeout: 15_000,
    });
    await page.locator('extensions-detail-view #dev-reload-button').click();
    await restarted;
    return { id, managerVersion: managerManifest.version, scriptName: SCRIPT_NAME };
  } finally {
    await page.close();
  }
}

async function installUserscript(
  context: BrowserContext,
  id: string,
  root: string,
  output: string
) {
  const installed = await prepareUserscriptManager(context, id, root);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${id}/options.html`);
    const labels = await readManagerUiLabels(page, id);
    await page.getByText(labels.utilities, { exact: true }).click();
    const confirmationPromise = context.waitForEvent('page');
    await page
      .locator('input[type=file]')
      .setInputFiles(join(root, 'dist/yt-live-chat-overlay.user.js'));
    const confirmation = await confirmationPromise;
    await confirmation.waitForURL(`chrome-extension://${id}/ask.html*`);
    const closed = confirmation.waitForEvent('close');
    await confirmation.getByRole('button', { name: labels.install, exact: true }).click();
    await closed;
    await page.reload();
    await page.getByText(labels.installedUserscripts, { exact: true }).first().click();
    await page.getByText(SCRIPT_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await page.screenshot({ path: join(output, 'userscript-installed.png') });
    return installed;
  } catch (error) {
    await page.screenshot({ path: join(output, 'userscript-install-error.png') }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
}

export async function readPublicPageState(page: Page) {
  return page.evaluate(readPublicPageBrowserState).catch(() => ({
    chatMode: 'unknown',
    chatRendererFound: false,
    playabilityStatus: null,
    loginRedirect: false,
    consentRedirect: false,
  }));
}

/** Exercise actual installed userscript output on public chat without changing site responses. */
async function observePublicUserscriptMedia(
  page: Page,
  output: string,
  index: number,
  imageResponses: PublicImageResponse[]
): Promise<{ image: WorkflowStep; resize: WorkflowStep }> {
  let image: WorkflowStep = {
    status: 'unverified',
    reason: 'public-image-not-observed',
    probeCapability: 'unproven',
    productVerdict: 'unverified',
  };
  const originalShowAuthor = await page.evaluate(
    () => window.__ytChatOverlay?.getSettings().showAuthor
  );
  try {
    if (!originalShowAuthor) throw new Error('Installed userscript settings unavailable');
    await page.evaluate((showAuthor) => {
      window.__ytChatOverlay?.applySettings({ showAuthor: { ...showAuthor, normal: true } });
    }, originalShowAuthor);
    await page
      .waitForFunction(
        () =>
          (
            window as Window & {
              __ytPublicImageDraws?: PublicImageDraw[];
            }
          ).__ytPublicImageDraws?.length,
        undefined,
        { timeout: 15_000 }
      )
      .catch(() => null);
    const draws = await page.evaluate(
      () =>
        (
          window as Window & {
            __ytPublicImageDraws?: PublicImageDraw[];
          }
        ).__ytPublicImageDraws?.slice(0, 16) ?? []
    );
    const assessed = assessPublicImage(draws, imageResponses);
    if (assessed.status === 'passed') {
      const imageScreenshot = 'live-' + index + '-public-image.png';
      await page.screenshot({ path: join(output, imageScreenshot) });
      image = {
        status: 'passed',
        probeCapability: 'overlay-image-draw-observed',
        productVerdict: 'visible-public-image-observed',
        sourceType: assessed.draw.sourceType,
        sourceHost: new URL(assessed.draw.url).hostname,
        sourceSha256: createHash('sha256').update(assessed.draw.url).digest('hex'),
        naturalWidth: assessed.draw.naturalWidth,
        naturalHeight: assessed.draw.naturalHeight,
        pixelAlpha: assessed.draw.pixelAlpha,
        responseStatus: assessed.response.status,
        responseContentType: assessed.response.contentType,
        screenshot: imageScreenshot,
      };
    } else {
      image = {
        status: 'unverified',
        reason: assessed.reason,
        probeCapability: draws.length > 0 ? 'overlay-draw-observed' : 'unproven',
        productVerdict: 'unverified',
        drawCount: draws.length,
        imageResponseCount: imageResponses.length,
      };
    }
  } catch {
    image = {
      status: 'unverified',
      reason: 'public-image-probe-error',
      probeCapability: 'unproven',
      productVerdict: 'unverified',
    };
  } finally {
    if (originalShowAuthor) {
      const restored = await page.evaluate((showAuthor) => {
        window.__ytChatOverlay?.applySettings({ showAuthor });
        const current = window.__ytChatOverlay?.getSettings().showAuthor;
        return Object.entries(showAuthor).every(
          ([key, value]) => current?.[key as keyof typeof current] === value
        );
      }, originalShowAuthor);
      if (!restored) {
        image = {
          status: 'unverified',
          reason: 'public-image-setting-restore-unverified',
          probeCapability: image.probeCapability,
          productVerdict: 'unverified',
        };
      }
    }
  }

  const originalViewport = page.viewportSize();
  if (!originalViewport) {
    return { image, resize: { status: 'unverified', reason: 'viewport-unavailable' } };
  }
  const originalVideoPaused = await page
    .locator('video')
    .first()
    .evaluate((element) => (element as HTMLVideoElement).paused);
  let resized = false;
  let overlayPaused = false;
  let resize: WorkflowStep;
  try {
    await page
      .locator('video')
      .first()
      .evaluate((element) => (element as HTMLVideoElement).pause());
    await page.keyboard.press('Control+Space');
    overlayPaused = true;
    await page
      .waitForFunction(
        () =>
          /\bActive:\s*[1-9]\d*\b/u.test(
            document.querySelector('#yt-chat-overlay-debug')?.textContent ?? ''
          ),
        undefined,
        { timeout: 10_000 }
      )
      .catch(() => null);
    const before = await page.evaluate(readPublicCanvasFrame);
    const beforeScreenshot = 'live-' + index + '-before-resize.png';
    await page.screenshot({ path: join(output, beforeScreenshot) });
    const nextViewport = {
      width:
        originalViewport.width > 1200 ? originalViewport.width - 320 : originalViewport.width + 320,
      height:
        originalViewport.height > 720
          ? originalViewport.height - 160
          : originalViewport.height + 160,
    };
    await page.setViewportSize(nextViewport);
    resized = true;
    if (before) {
      await page
        .waitForFunction(
          ({ width, height }) => {
            const canvas = document.querySelector('#yt-live-chat-overlay canvas');
            return (
              canvas instanceof HTMLCanvasElement &&
              (Math.abs(canvas.width - width) >= 32 || Math.abs(canvas.height - height) >= 32)
            );
          },
          { width: before.width, height: before.height },
          { timeout: 8_000 }
        )
        .catch(() => null);
    }
    const after = await page.evaluate(readPublicCanvasFrame);
    const afterScreenshot = 'live-' + index + '-after-resize.png';
    await page.screenshot({ path: join(output, afterScreenshot) });
    const reason = assessPublicResize(before, after);
    resize = {
      status: reason === null ? 'passed' : 'unverified',
      reason,
      before,
      after,
      viewportBefore: originalViewport,
      viewportAfter: nextViewport,
      beforeScreenshot,
      afterScreenshot,
      scope: 'one paused public resize; no capacity-exhaustion or message-identity claim',
    };
  } catch {
    resize = { status: 'unverified', reason: 'public-resize-probe-error' };
  } finally {
    if (resized) await page.setViewportSize(originalViewport);
    if (overlayPaused) await page.keyboard.press('Control+Space');
    if (!originalVideoPaused)
      await page
        .locator('video')
        .first()
        .evaluate((element) => (element as HTMLVideoElement).play())
        .catch(() => {});
  }
  return { image, resize };
}

/** Observe a real watch page without supplying application code or site responses. */
async function inspectLivePage(
  context: BrowserContext,
  url: string,
  output: string,
  index: number,
  installation: 'extension' | 'userscript',
  nextUrl: string = url,
  extensionResources: {
    extensionId: string;
    expected: Record<string, ExpectedResource>;
  } | null = null
) {
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  if (installation === 'userscript') await page.addInitScript(installPublicImageDrawProbe);
  const imageResponses: PublicImageResponse[] = [];
  page.on('response', (response) => {
    if (installation !== 'userscript') return;
    const contentType = response.headers()['content-type'] ?? '';
    if (!/^image\//iu.test(contentType) || !isPublicImageUrl(response.request().url())) return;
    imageResponses.push({
      url: response.request().url(),
      status: response.status(),
      contentType,
    });
    if (imageResponses.length > 64) imageResponses.shift();
  });
  const pageErrors: string[] = [];
  const workerDiagnostics: { type: string; text: string; url: string }[] = [];
  const consoleErrors: { type: string; text: string; url: string }[] = [];
  let consoleErrorOverflow = 0;
  page.on('pageerror', (error) => pageErrors.push(error.name));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') {
      if (consoleErrors.length < 32)
        consoleErrors.push({
          type: 'error',
          text: text.slice(0, 1000),
          url: message.location().url,
        });
      else consoleErrorOverflow++;
    }
    if (/worker|TrustedScriptURL/i.test(text) && workerDiagnostics.length < 20) {
      workerDiagnostics.push({
        type: message.type(),
        text: redactDiagnosticText(text),
        url: redactDiagnosticText(message.location().url),
      });
    }
  });
  const observation: LiveObservation = { url, status: 'not-run', mocked: false };
  let activeNavigation = 'initial-watch';
  const finishResourceCapture = extensionResources
    ? beginOwnedExtensionResourceCapture(
        page,
        extensionResources.extensionId,
        extensionResources.expected,
        () => ({ sourcePhase: observation.phase, navigation: activeNavigation })
      )
    : null;
  let deadlineReached = false;
  let deadlineCleanup: Promise<unknown> | undefined;
  const screenshot = `live-${index}.png`;
  const deadline = setTimeout(() => {
    deadlineReached = true;
    deadlineCleanup = page
      .screenshot({ path: join(output, screenshot), timeout: 3000 })
      .then(
        () => {
          observation.screenshot = screenshot;
        },
        () => {}
      )
      .finally(() => page.close().catch(() => {}));
  }, 120_000);
  try {
    observation.phase = 'navigation';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    observation.finalUrl = page.url();
    observation.title = await page.title();
    const rejectConsent = page.getByRole('button', { name: 'Reject all', exact: true });
    if (await rejectConsent.isVisible().catch(() => false)) await rejectConsent.click();
    observation.phase = 'player';
    await page.locator('#movie_player').waitFor({ state: 'visible', timeout: 20_000 });
    observation.video = await page
      .locator('video')
      .first()
      .evaluate((element) => {
        const video = element as HTMLVideoElement;
        video.muted = true;
        void video.play().catch(() => {});
        return {
          paused: video.paused,
          readyState: video.readyState,
          errorCode: video.error?.code ?? null,
        };
      });
    observation.phase = 'settings';
    const settingsButton = page.locator('#yt-chat-overlay-settings-button');
    await settingsButton.waitFor({ state: 'visible', timeout: 20_000 });
    await settingsButton.focus();
    await page.keyboard.press('Enter');
    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await modal.waitFor({ state: 'visible' });
    const fontSize = modal.locator('input[name="fontSize"]');
    observation.fontSize = Number(await fontSize.inputValue());
    await page.keyboard.press('Escape');
    observation.phase = 'chat';
    await page.waitForFunction(
      () => document.querySelectorAll('.yt-live-chat-overlay-live-region > p').length > 0,
      undefined,
      { timeout: 30_000 }
    );
    observation.renderedMessages = await page
      .locator('.yt-live-chat-overlay-live-region > p')
      .count();
    observation.canvasAttached = (await page.locator('#yt-live-chat-overlay canvas').count()) === 1;
    const renderer = await page.locator('#yt-chat-overlay-debug').innerText();
    observation.renderer = renderer.includes('Render: n/a') ? 'worker' : 'main';
    const bridge = await readExtensionBridgeDiagnostic(page);
    observation.extensionBridge = bridge;
    observation.installedBridgeReady = Boolean(
      bridge.workerSupported &&
      bridge.storageType === 'chrome.storage.local' &&
      bridge.workerUrlUsesDocumentOrigin
    );
    Object.assign(
      observation,
      validateLiveRenderer(
        observation.renderer,
        installation,
        workerDiagnostics,
        observation.installedBridgeReady
      )
    );
    const pageState = await readPublicPageState(page);
    observation.chatMode = pageState.chatMode;
    observation.provider = pageState;
    observation.workflow = {
      startup: {
        status: 'passed',
        chatMode: observation.chatMode,
        renderedMessages: observation.renderedMessages,
      },
    };
    if (installation === 'userscript') {
      observation.phase = 'public-media';
      const media = await observePublicUserscriptMedia(page, output, index, imageResponses);
      observation.workflow.image = media.image;
      observation.workflow.resize = media.resize;
    }
    observation.phase = 'pause';
    observation.workflow.pause = await page
      .locator('video')
      .first()
      .evaluate((element) => {
        const video = element as HTMLVideoElement;
        video.pause();
        return { status: video.paused ? 'passed' : 'unverified', paused: video.paused };
      });
    observation.phase = 'resume';
    observation.workflow.resume = await page
      .locator('video')
      .first()
      .evaluate(async (element) => {
        const video = element as HTMLVideoElement;
        try {
          await video.play();
        } catch {
          return { status: 'unverified', reason: 'play-rejected' };
        }
        return { status: video.paused ? 'unverified' : 'passed', paused: video.paused };
      });
    observation.phase = 'seek';
    const seekRange = await page
      .locator('video')
      .first()
      .evaluate((element) => {
        const video = element as HTMLVideoElement;
        if (!video.seekable.length) return null;
        const last = video.seekable.length - 1;
        return {
          currentTime: video.currentTime,
          start: video.seekable.start(last),
          end: video.seekable.end(last),
        };
      });
    const target =
      seekRange &&
      selectPublicSeekTarget(seekRange, { preferBackward: pageState.chatMode === 'live' });
    if (target === null) {
      observation.workflow.seek = {
        status: 'unverified',
        reason: 'seek-range-unavailable',
        range: seekRange,
      };
    } else {
      observation.workflow.seek = await page
        .locator('video')
        .first()
        .evaluate(async (element, seekTo: number) => {
          const video = element as HTMLVideoElement;
          const preSeekTime = video.currentTime;
          const last = video.seekable.length - 1;
          const range =
            last >= 0 ? { start: video.seekable.start(last), end: video.seekable.end(last) } : null;
          if (!range || seekTo < range.start || seekTo > range.end) {
            return {
              status: 'unverified',
              reason: 'seek-target-out-of-range',
              target: seekTo,
              range,
              preSeekTime,
              afterTime: preSeekTime,
              seekedEvent: false,
            };
          }
          if (Math.abs(seekTo - preSeekTime) < 1) {
            return {
              status: 'unverified',
              reason: 'seek-target-no-longer-distinct',
              target: seekTo,
              range,
              preSeekTime,
              afterTime: preSeekTime,
              seekedEvent: false,
            };
          }
          const completed = new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 8000);
            video.addEventListener(
              'seeked',
              () => {
                clearTimeout(timeout);
                resolve(true);
              },
              { once: true }
            );
          });
          video.currentTime = seekTo;
          const seeked = await completed;
          const afterTime = video.currentTime;
          const positionMatched = Math.abs(afterTime - seekTo) < 2;
          return {
            status: seeked && positionMatched ? 'passed' : 'unverified',
            reason: !seeked
              ? 'seeked-event-timeout'
              : positionMatched
                ? null
                : 'seek-position-mismatch',
            target: seekTo,
            range,
            preSeekTime,
            afterTime,
            seekedEvent: seeked,
            currentTime: afterTime,
          };
        }, target);
      const seek = observation.workflow.seek;
      assert(seek);
      seek.selectionRange = seekRange;
    }
    observation.phase = 'navigation-transition';
    activeNavigation = 'next-watch';
    const diagnosticStart = workerDiagnostics.length;
    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('#movie_player').waitFor({ state: 'visible', timeout: 20_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.yt-live-chat-overlay-live-region > p').length > 0,
      undefined,
      { timeout: 30_000 }
    );
    const nextPageState = await readPublicPageState(page);
    const nextRendererText = await page.locator('#yt-chat-overlay-debug').innerText();
    const nextRenderer = nextRendererText.includes('Render: n/a') ? 'worker' : 'main';
    const nextBridge = await readExtensionBridgeDiagnostic(page);
    const nextBridgeReady = Boolean(
      nextBridge.workerSupported &&
      nextBridge.storageType === 'chrome.storage.local' &&
      nextBridge.workerUrlUsesDocumentOrigin
    );
    const nextRendererPolicy = validateLiveRenderer(
      nextRenderer,
      installation,
      workerDiagnostics.slice(diagnosticStart),
      nextBridgeReady
    );
    observation.workflow.navigation = {
      status: nextPageState.chatMode === 'unknown' ? 'unverified' : 'passed',
      reason: nextPageState.chatMode === 'unknown' ? 'chat-mode-unknown' : null,
      kind: nextUrl === url ? 'reload' : 'cross-watch',
      chatMode: nextPageState.chatMode,
      canvasAttached: true,
      renderer: nextRenderer,
      installedBridgeReady: nextBridgeReady,
      extensionBridge: nextBridge,
      workerPolicyFallback: nextRendererPolicy.workerPolicyFallback,
      renderedMessages: await page.locator('.yt-live-chat-overlay-live-region > p').count(),
    };
    if (pageState.chatMode === 'unknown') {
      const startup = observation.workflow.startup;
      assert(startup);
      startup.status = 'unverified';
      startup.reason = 'chat-mode-unknown';
    }
    const failedStage = Object.entries(observation.workflow).find(
      ([, stage]) => stage.status !== 'passed'
    );
    if (failedStage) {
      observation.status = 'unverified';
      observation.reason = `${failedStage[0]}-${failedStage[1].reason ?? 'state-not-observed'}`;
      observation.phase = failedStage[0];
      return observation;
    }
    observation.status = 'passed';
    observation.phase = 'complete';
  } catch (error) {
    observation.status = 'unverified';
    observation.provider = await readPublicPageState(page);
    observation.reason = deadlineReached
      ? 'live-url-deadline'
      : observation.provider.loginRedirect
        ? 'provider-login-redirect'
        : observation.provider.consentRedirect
          ? 'provider-consent-redirect'
          : observation.provider.playabilityStatus &&
              observation.provider.playabilityStatus !== 'OK'
            ? 'provider-playability-unavailable'
            : !observation.provider.chatRendererFound && observation.phase === 'chat'
              ? 'provider-chat-renderer-unavailable'
              : error instanceof Error && error.name === 'TimeoutError'
                ? `${observation.phase}-timeout`
                : `${observation.phase}-error`;
  } finally {
    clearTimeout(deadline);
    if (deadlineCleanup) await deadlineCleanup;
    if (finishResourceCapture) {
      assert(extensionResources);
      observation.extensionResources = {
        installedExtensionId: extensionResources.extensionId,
        ...(await finishResourceCapture()),
      };
    }
    observation.workerDiagnostics = workerDiagnostics;
    if (!page.isClosed()) {
      await page.screenshot({ path: join(output, screenshot) }).then(
        () => {
          observation.screenshot = screenshot;
        },
        () => {}
      );
    }
    await page.close();
    observation.pageErrorTypes = [...new Set(pageErrors)];
    observation.unexpectedConsoleErrors =
      consoleErrorOverflow +
      countUnexpectedLiveErrors(consoleErrors, observation.workerPolicyFallback ?? false);
    observation.hostConsoleErrors = consoleErrors.filter(isYouTubeHostError).length;
    observation.consoleErrors = consoleErrors.map(({ type, text, url }) => ({
      type,
      text: redactDiagnosticText(text),
      url: redactDiagnosticText(url),
    }));
    if (
      observation.status === 'passed' &&
      (observation.pageErrorTypes.length > 0 || observation.unexpectedConsoleErrors > 0)
    ) {
      observation.status = 'unverified';
      observation.reason = 'unexpected-page-errors';
    }
  }
  return observation;
}

export function requireLiveSuccess(
  observations: Array<Pick<LiveObservation, 'status'> & Partial<LiveObservation>>
) {
  assert(
    observations.every(
      (item) =>
        item.status === 'passed' &&
        item.canvasAttached &&
        (item.renderedMessages ?? 0) > 0 &&
        (item.pageErrorTypes?.length ?? 0) === 0 &&
        (item.unexpectedConsoleErrors ?? 0) === 0
    ),
    'One or more requested live pages did not prove installed application rendering'
  );
}

/** The installed fixture returns only after seven page-fetch callback assertions. */
export function requireInstalledPageFetchEvidence(
  fixture: {
    checks?: { sustainedViewingLifecycle?: boolean };
    observations?: {
      sustainedViewing?: {
        firstSessionIngressIds?: unknown[];
        firstSessionAccessibleIds?: unknown[];
        secondSessionIds?: unknown[];
        hiddenMessageSuppressed?: boolean;
        oldCanvasDetached?: boolean;
        videoPauseDropDelta?: number;
      };
      [key: string]: unknown;
    };
  } | null
) {
  assert.equal(
    fixture?.checks?.sustainedViewingLifecycle,
    true,
    'Installed page-fetch lifecycle was not verified'
  );
  const sustained = fixture?.observations?.sustainedViewing;
  const expectedFirstSession = [
    'windows-sustained-low-1',
    'windows-sustained-low-2',
    ...Array.from({ length: 8 }, (_, index) => `windows-sustained-burst-${index + 1}`),
    'windows-sustained-paused-1',
    'windows-sustained-paused-2',
    'windows-sustained-visible',
  ];
  assert.deepEqual(
    sustained?.firstSessionIngressIds,
    expectedFirstSession,
    'Installed page-fetch ingress IDs are incomplete'
  );
  assert.deepEqual(sustained.secondSessionIds, ['windows-sustained-second-video']);
  assert.equal(sustained.hiddenMessageSuppressed, true);
  assert.equal(sustained.oldCanvasDetached, true);
  assert.equal(sustained.videoPauseDropDelta, 2);
  const accessibleIds = sustained?.firstSessionAccessibleIds;
  assert(
    Array.isArray(accessibleIds) && expectedFirstSession.every((id) => accessibleIds.includes(id)),
    'Installed page-fetch messages were not accessible after the lifecycle phases'
  );
  return {
    callbackAssertionsCompleted: true,
    callbackPhases: ['low-1', 'low-2', 'burst', 'paused', 'hidden', 'visible', 'second-video'],
    callbackCountsAsserted: {
      'low-1': 1,
      'low-2': 1,
      burst: 8,
      paused: 2,
      hidden: 1,
      visible: 1,
      'second-video': 1,
    },
    source: 'profile.ts verifySustainedViewingLifecycle page-world fetch and product callbacks',
  };
}

/** Attempt every owned cleanup stage even when an earlier operation fails. */
export async function cleanupChromeInstallation(
  {
    browserProcessId,
    browserProcessIdentity,
    context,
    cdp,
    extensionId,
    profile,
    output,
    result,
    root,
  }: CleanupOptions,
  {
    checkProcessAlive = isProcessAlive,
    terminateProcessTree = () => {
      assert(browserProcessIdentity, 'Owned browser process identity is unavailable');
      return terminateOwnedChromeProcess(browserProcessIdentity);
    },
    waitForExit,
  }: {
    checkProcessAlive?: (processId: number) => Promise<boolean>;
    terminateProcessTree?: (processId: number) => Promise<unknown>;
    waitForExit?: (processId: number, timeoutMs: number) => Promise<boolean>;
  } = {}
) {
  const errors: unknown[] = [];
  const errorTypes: { stage: string; errorType: string }[] = [];
  const recordError = (stage: string, error: unknown) => {
    errors.push(error);
    errorTypes.push({ stage, errorType: error instanceof Error ? error.name : typeof error });
  };
  if (cdp && extensionId) {
    try {
      await cdp.send('Extensions.uninstall', { id: extensionId });
      result.cleanup.extensionUninstalled = true;
    } catch (error) {
      recordError('extension-uninstall', error);
    }
  }
  try {
    await context?.close();
    result.cleanup.browserClosed = true;
  } catch (error) {
    recordError('context-close', error);
    try {
      const ownedBrowser = context?.browser?.();
      if (!ownedBrowser) throw new Error('Owned browser cleanup handle is unavailable');
      await ownedBrowser.close();
      result.cleanup.browserClosed = true;
    } catch (fallbackError) {
      recordError('browser-close', fallbackError);
    }
  }
  let browserProcessExited = result.cleanup.browserClosed === true;
  if (browserProcessId !== undefined) {
    try {
      if (result.cleanup.browserClosed === true) {
        browserProcessExited = waitForExit
          ? await waitForExit(browserProcessId, GRACEFUL_PROCESS_EXIT_MS)
          : await waitForProcessExit(browserProcessId, checkProcessAlive, GRACEFUL_PROCESS_EXIT_MS);
      } else {
        browserProcessExited = !(await checkProcessAlive(browserProcessId));
      }
    } catch (error) {
      browserProcessExited = false;
      recordError('browser-process-exit-check', error);
    }
    if (!browserProcessExited) {
      let terminationError;
      let terminationErrorStage;
      try {
        await terminateProcessTree(browserProcessId);
      } catch (error) {
        terminationError = error;
        terminationErrorStage = 'browser-process-tree-termination';
      }
      try {
        browserProcessExited = waitForExit
          ? await waitForExit(browserProcessId, PROCESS_EXIT_TIMEOUT_MS)
          : await waitForProcessExit(browserProcessId, checkProcessAlive);
      } catch (error) {
        terminationError ??= error;
        terminationErrorStage ??= 'browser-process-exit-check';
        browserProcessExited = false;
      }
      if (!browserProcessExited) {
        recordError(
          terminationErrorStage ?? 'browser-process-tree-exit',
          terminationError ?? new Error('Task-owned browser process tree did not terminate')
        );
      }
    }
  } else if (!browserProcessExited) {
    recordError(
      'browser-process-identity',
      new Error('Task-owned browser process identity is unavailable')
    );
  }
  result.cleanup.browserProcessExited = browserProcessExited;
  if (browserProcessExited) {
    try {
      await removeOwnedChromeProfile(root, profile);
      result.cleanup.profileRemoved = true;
    } catch (error) {
      recordError('profile-remove', error);
    }
  } else {
    result.cleanup.profilePreserved = true;
  }
  result.cleanup.errorCount = errors.length;
  result.cleanup.errorTypes = errorTypes;
  await writeFile(join(output, 'installation-result.json'), JSON.stringify(result, null, 2));
  if (errors.length) throw new AggregateError(errors, 'Chrome installation cleanup failed');
}

/** Install real browser packages in an isolated profile and exercise their normal delivery. */
export async function runChromeInstallation({
  chromium,
  root,
  output,
  browserName = 'chrome',
  headless = false,
  installation,
  liveUrls = [],
  liveObservation = null,
}: ChromeOptions) {
  assert(['chrome', 'msedge'].includes(browserName), 'Unsupported Chromium channel');
  assert(['extension', 'userscript'].includes(installation), 'Unknown installation mode');
  assert(
    Array.isArray(liveUrls) && liveUrls.length <= 3,
    'At most three live URLs can run within the guest deadline'
  );
  if (liveObservation !== null) {
    assert.deepEqual(liveObservation, { mode: 'duration', duration_seconds: 1200 });
    assert.equal(browserName, 'chrome', 'Duration observation requires installed Chrome');
    assert.equal(headless, false, 'Duration observation requires a headed browser');
    assert.equal(installation, 'extension', 'Duration observation requires the extension');
    assert.equal(liveUrls.length, 1, 'Duration observation requires one public live URL');
    return runChromeDurationInstallation({
      chromium,
      root,
      output,
      installation,
      liveUrls,
      liveObservation,
    });
  }
  const upgradeInputs = installation === 'userscript' ? await loadUpgradeInputs(root) : null;
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let extensionId: string | undefined;
  let browserProcessId: number | undefined;
  let browserProcessIdentity: ChromeProcessIdentity | undefined;
  let primaryError: unknown;
  const result: ChromeResult = {
    installation,
    fixture: null,
    placementTiming: null,
    bitmapLifecycle: null,
    userscriptUpgrade: null,
    live: [],
    liveWorkflowCoverage: null,
    cleanup: {},
  };
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: browserName,
      headless,
      locale: 'en-US',
      viewport: { width: 1280, height: 720 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--mute-audio'],
    });
    const browser = context.browser();
    assert(browser);
    result.browserVersion = browser.version();
    cdp = await browser.newBrowserCDPSession();
    browserProcessId = readOwnedBrowserProcessId(await cdp.send('SystemInfo.getProcessInfo'));
    browserProcessIdentity = await captureOwnedChromeProcess(browserProcessId, profile);
    result.cleanup.browserProcessIdentified = true;
    await enableDeveloperMode(context, browserName);
    if (installation === 'extension') {
      ({ id: extensionId } = (await cdp.send('Extensions.loadUnpacked', {
        path: join(root, 'dist-extension'),
      })) as { id: string });
      assert.equal(typeof extensionId, 'string');
      result.installationMethod = 'cdp-unpacked-extension';
    } else {
      ({ id: extensionId } = (await cdp.send('Extensions.loadUnpacked', {
        path: join(root, 'test-tools/userscript-manager'),
      })) as { id: string });
      assert(extensionId);
      if (upgradeInputs) {
        result.userscriptManager = await prepareUserscriptManager(context, extensionId, root);
        try {
          result.userscriptUpgrade = await runManagerUpgrade(
            context,
            extensionId,
            root,
            upgradeInputs,
            output
          );
        } catch (error) {
          const receipt =
            error && typeof error === 'object' && 'upgradeObservation' in error
              ? error.upgradeObservation
              : null;
          result.userscriptUpgrade =
            receipt &&
            typeof receipt === 'object' &&
            'status' in receipt &&
            typeof receipt.status === 'string'
              ? (receipt as UpgradeResult)
              : { status: 'failed' };
          throw error;
        }
        result.installationMethod = 'real-manager-ui-upgrade';
      } else {
        result.userscriptManager = await installUserscript(context, extensionId, root, output);
        result.installationMethod = 'real-manager-ui-import';
      }
    }
    result.fixture = await runFixture({
      browser,
      root,
      output,
      installedContext: context,
      installedExtensionId: extensionId,
      expectedRenderer: installation === 'extension' ? 'worker' : 'main',
    });
    if (result.userscriptUpgrade) {
      assert(upgradeInputs && 'candidateUnsafeWindowGrant' in result.userscriptUpgrade);
      assert.equal(result.fixture.checks.installedApplicationDelivery, true);
      const pageFetch = requireInstalledPageFetchEvidence(result.fixture);
      result.userscriptUpgrade.effectiveGrantEvidence = {
        candidateMetadata: result.userscriptUpgrade.candidateUnsafeWindowGrant,
        exactManagerEditorBytes:
          (result.userscriptUpgrade.after as { editorSha256?: string } | undefined)
            ?.editorSha256 === upgradeInputs.candidateSha256,
        actualPageFetchIngress: pageFetch.callbackAssertionsCompleted,
        pageFetch,
      };
    }
    if (browserName === 'msedge' && installation === 'extension') {
      result.bitmapLifecycle = await runBitmapLifecycleFixture({
        context,
        root,
        extensionId,
      });
      assert.equal(
        result.bitmapLifecycle.status,
        'passed',
        'Installed Edge real bitmap lifecycle fixture failed'
      );
      // A baseline-only harness commit can set this to true with the same probe bytes.
      const comparisonOnly = false;
      result.placementTiming = await runPlacementTimingFixture({
        context,
        root,
        output,
        extensionId,
        comparisonOnly,
      });
      assert.equal(
        result.placementTiming.status,
        'passed',
        'Installed Edge placement or replay fixture did not satisfy its observations'
      );
    }
    const extensionResources =
      installation === 'extension' && liveUrls.length > 0
        ? { extensionId, expected: await readExpectedExtensionResources(root) }
        : null;
    for (const [index, url] of liveUrls.entries()) {
      const nextUrl = liveUrls.length > 1 ? liveUrls[(index + 1) % liveUrls.length] : url;
      result.live.push(
        await inspectLivePage(
          context,
          url,
          output,
          index,
          installation,
          nextUrl,
          extensionResources
        )
      );
    }
    if (liveUrls.length > 0) {
      const observedModes = [...new Set(result.live.map((item) => item.chatMode))];
      const crossWatch = result.live.some(
        (item) =>
          item.workflow?.navigation?.kind === 'cross-watch' &&
          item.workflow.navigation.status === 'passed'
      );
      const liveWorkflowCoverage = {
        observedModes,
        crossWatch,
        status:
          observedModes.includes('live') &&
          observedModes.includes('replay') &&
          crossWatch &&
          result.live.every((item) => item.status === 'passed')
            ? 'complete'
            : 'partial',
      };
      result.liveWorkflowCoverage = liveWorkflowCoverage;
      if (browserName === 'msedge' && installation === 'extension' && liveUrls.length >= 2) {
        assert.equal(
          liveWorkflowCoverage.status,
          'complete',
          'Public live and replay workflow coverage is incomplete'
        );
      }
    }
    requireLiveSuccess(result.live);
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupChromeInstallation({
        browserProcessId,
        browserProcessIdentity,
        context,
        cdp,
        extensionId,
        profile,
        output,
        result,
        root,
      });
    } catch (cleanupError) {
      if (primaryError)
        throw new AggregateError([primaryError, cleanupError], 'Installation and cleanup failed');
      throw cleanupError;
    }
  }
}

async function runChromeDurationInstallation({
  chromium,
  root,
  output,
  installation,
  liveUrls,
  liveObservation,
}: Required<Pick<ChromeOptions, 'chromium' | 'root' | 'output' | 'installation' | 'liveUrls'>> & {
  liveObservation: { mode: 'duration'; duration_seconds: 1200 };
}) {
  const [{ launchOwnedNaturalChrome }, { runLiveDuration }] = await Promise.all([
    import('./natural-chrome.ts'),
    import('./live-duration.ts'),
  ]);
  let ownedChrome: Awaited<ReturnType<typeof launchOwnedNaturalChrome>> | undefined;
  let extensionId: string | undefined;
  let primaryError: unknown;
  const result: ChromeResult<Awaited<ReturnType<typeof runLiveDuration>>> = {
    installation,
    fixture: null,
    live: [],
    liveObservation,
    cleanup: {},
  };
  try {
    ownedChrome = await launchOwnedNaturalChrome({ chromium, root, output });
    const { browser, context } = ownedChrome;
    result.browserVersion = browser.version();
    result.naturalChrome = ownedChrome.launchEvidence;
    result.cleanup.browserProcessIdentified = true;
    await enableDeveloperMode(context, 'chrome');
    ({ id: extensionId } = (await ownedChrome.cleanupCdp.send('Extensions.loadUnpacked', {
      path: join(root, 'dist-extension'),
    })) as { id: string });
    assert.equal(typeof extensionId, 'string');
    result.installationMethod = 'cdp-unpacked-extension';
    result.fixture = await runFixture({
      browser,
      root,
      output,
      installedContext: context,
      installedExtensionId: extensionId,
      expectedRenderer: 'worker',
    });
    const liveUrl = liveUrls[0];
    assert(liveUrl);
    const observation = await runLiveDuration({
      context,
      url: liveUrl,
      output,
      installation: 'extension',
    });
    result.live.push(observation);
    assert.equal(
      observation.evidenceStatus,
      'observed',
      `Duration observation remained unverified: ${observation.evidenceStatusReasons?.join(', ')}`
    );
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (ownedChrome) {
      try {
        await cleanupChromeInstallation({
          browserProcessId: ownedChrome.browserProcessId,
          browserProcessIdentity: ownedChrome.browserProcessIdentity,
          context: ownedChrome.cleanupContext,
          cdp: ownedChrome.cleanupCdp,
          extensionId,
          profile: ownedChrome.profile,
          output,
          result,
          root,
        });
      } catch (cleanupError) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, cleanupError],
            'Duration observation and cleanup failed'
          );
        }
        throw cleanupError;
      }
    }
  }
}
