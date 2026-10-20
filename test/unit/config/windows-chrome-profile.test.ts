// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import type { BrowserContext, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import * as chromeInstallModule from '../../../validation/windows/chrome-install.ts';
import * as liveRenderingModule from '../../../validation/windows/live-rendering.ts';

const {
  cleanupChromeInstallation,
  enableDeveloperMode,
  readOwnedBrowserProcessId,
  isOwnedManagerOptionsUrl,
  readManagerUiLabels,
  readPublicPageState,
  requireLiveSuccess,
  requireManagerUiLabels,
  selectPublicSeekTarget,
  ownedExtensionResourcePath,
  diagnoseUnsafeOriginConsole,
  redactChromeDiagnosticText,
  compareOwnedExtensionResourceBody,
  beginOwnedExtensionResourceCapture,
  beginConnectionAllowlistReportCapture,
  installConnectionAllowlistObserver,
  drainConnectionAllowlistObserver,
  readBoundedPackagedResource,
  readBundledUserscriptVersion,
} = chromeInstallModule;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'yt-chrome-profile-test-'));
  roots.push(root);
  const profile = join(root, 'chrome-install-owned');
  const output = join(root, 'output');
  await mkdir(profile);
  await mkdir(output);
  await writeFile(join(root, 'keep'), 'unrelated fixture');
  return { root, profile, output };
}

describe('installed Chrome acceptance outcomes', () => {
  it('observes only the public top watch frame and drains callback and pending reports once', () => {
    const id = 'a'.repeat(32);
    const instances: Array<{
      callback: (reports: unknown[]) => void;
      options: unknown;
      pending: unknown[];
    }> = [];
    class FakeReportingObserver {
      pending: unknown[] = [];
      constructor(
        readonly callback: (reports: unknown[]) => void,
        readonly options: unknown
      ) {
        instances.push(this);
      }
      observe() {}
      takeRecords() {
        return this.pending.splice(0);
      }
    }
    const window: { top?: unknown; __ytPolicyReportState?: unknown } = {};
    window.top = window;
    const sandbox = {
      window,
      location: { protocol: 'https:', hostname: 'www.youtube.com', pathname: '/watch' },
      ReportingObserver: FakeReportingObserver,
      URL,
      performance: { now: () => 12.7 },
    };
    const install = () =>
      runInNewContext(
        `(${installConnectionAllowlistObserver.toString()})(${JSON.stringify(id)})`,
        sandbox
      );
    const drain = () =>
      runInNewContext(`(${drainConnectionAllowlistObserver.toString()})()`, sandbox) as {
        status: string;
        records: Array<Record<string, unknown>>;
        overflow: number;
      } | null;
    window.top = {};
    install();
    expect(instances).toHaveLength(0);
    window.top = window;
    sandbox.location.pathname = '/feed';
    install();
    expect(instances).toHaveLength(0);
    sandbox.location.pathname = '/watch';
    install();
    expect(instances[0]?.options).toEqual({ types: ['connection-allowlist'], buffered: true });
    const report = (connection: string) => ({
      type: 'connection-allowlist',
      body: {
        connection,
        url: 'https://www.youtube.com/watch?v=secret&token=private',
        disposition: 'report',
        allowlist: ['secret-policy'],
      },
    });
    instances[0]?.callback([report(`chrome-extension://${id}/page-script.js`)]);
    instances[0]?.pending.push(report(`chrome-extension://${id}/workers/renderer.js?secret=1`));
    instances[0]?.pending.push(report('https://other.example/secret'));
    const first = drain();
    expect(first).toMatchObject({ status: 'supported', overflow: 0 });
    expect(first?.records).toHaveLength(2);
    expect(first?.records[0]).toMatchObject({
      documentElapsedMs: 13,
      ownedResourcePath: 'page-script.js',
      ownedExtensionOriginOnly: false,
    });
    expect(first?.records[1]).toMatchObject({
      ownedResourcePath: null,
      ownedExtensionOriginOnly: true,
    });
    expect(JSON.stringify(first)).not.toContain('secret-policy');
    expect(JSON.stringify(first)).not.toContain('secret=1');
    expect(drain()?.records).toHaveLength(0);
    instances[0]?.callback(
      Array.from({ length: 18 }, () => report(`chrome-extension://${id}/page-script.js`))
    );
    expect(drain()).toMatchObject({ overflow: 2 });
  });

  it('distinguishes an unavailable page observer from a supported empty observer', () => {
    const window: { top?: unknown } = {};
    window.top = window;
    const sandbox = {
      window,
      location: { protocol: 'https:', hostname: 'www.youtube.com', pathname: '/watch' },
      URL,
      performance: { now: () => 0 },
    };
    runInNewContext(
      `(${installConnectionAllowlistObserver.toString()})(${JSON.stringify('a'.repeat(32))})`,
      sandbox
    );
    expect(
      runInNewContext(`(${drainConnectionAllowlistObserver.toString()})()`, sandbox)
    ).toMatchObject({ status: 'unsupported', records: [], overflow: 0 });
  });

  it('bounds policy report output across navigations without exposing report URLs', async () => {
    const id = 'a'.repeat(32);
    const record = {
      documentUrl: 'https://www.youtube.com/watch?v=secret&token=private',
      documentElapsedMs: 10,
      ownedResourcePath: 'page-script.js',
      ownedExtensionOriginOnly: false,
      disposition: 'enforce' as const,
    };
    const states = [
      { status: 'supported', records: Array.from({ length: 12 }, () => record), overflow: 0 },
      { status: 'supported', records: Array.from({ length: 7 }, () => record), overflow: 2 },
    ];
    const page = {
      addInitScript: vi.fn(async () => {}),
      evaluate: vi.fn(async () => states.shift()),
    } as unknown as Page;
    const capture = await beginConnectionAllowlistReportCapture(page, id);
    await capture.drain('initial-watch');
    await capture.drain('next-watch');
    const result = capture.finish();
    expect(result).toMatchObject({ status: 'observed', overflow: 5 });
    expect(result.records).toHaveLength(16);
    expect(result.records[0]?.documentUrlSha256).toBe(
      createHash('sha256').update(record.documentUrl).digest('hex')
    );
    expect(result.records[12]?.navigation).toBe('next-watch');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    [undefined, 'observer-missing', 'unverified'],
    [{ status: 'unsupported', records: [], overflow: 0 }, 'unsupported', 'unsupported'],
    [{ status: 'supported', records: [], overflow: 0 }, 'supported', 'supported-no-records'],
  ])('keeps absent policy reports diagnostic-only: %s', async (state, drainStatus, status) => {
    const page = {
      addInitScript: vi.fn(async () => {}),
      evaluate: vi.fn(async () => state),
    } as unknown as Page;
    const capture = await beginConnectionAllowlistReportCapture(page, 'a'.repeat(32));
    await capture.drain('initial-watch');
    expect(capture.finish()).toMatchObject({
      status,
      records: [],
      drains: [{ navigation: 'initial-watch', status: drainStatus }],
    });
  });

  it('rejects a malformed page report before it reaches the saved receipt', async () => {
    const page = {
      addInitScript: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        status: 'supported',
        overflow: 0,
        records: [
          {
            documentUrl: 'https://www.youtube.com/watch?v=private',
            documentElapsedMs: 2,
            ownedResourcePath: 'private-resource.js',
            ownedExtensionOriginOnly: false,
            disposition: 'enforce',
          },
        ],
      })),
    } as unknown as Page;
    const capture = await beginConnectionAllowlistReportCapture(page, 'a'.repeat(32));
    await capture.drain('initial-watch');
    expect(capture.finish()).toMatchObject({ status: 'unverified', records: [] });
    expect(JSON.stringify(capture.finish())).not.toContain('private');
  });
  it('reads the installed script version from a bounded bundle without a source package manifest', async () => {
    const { root } = await fixture();
    await mkdir(join(root, 'dist'));
    const script = join(root, 'dist', 'yt-live-chat-overlay.user.js');
    const metadata = (version: string, grant = 'unsafeWindow') =>
      `// ==UserScript==\n// @name YouTube Live Chat Overlay\n// @namespace https://github.com/PiesP\n// @version ${version}\n// @updateURL https://example.invalid/meta.js\n// @downloadURL https://example.invalid/script.js\n// @grant ${grant}\n// ==/UserScript==\n(() => {})();`;
    await writeFile(script, metadata('0.45.8'));
    expect(await readBundledUserscriptVersion(root)).toBe('0.45.8');
    await writeFile(script, metadata('0.45.8', 'GM_getValue'));
    await expect(readBundledUserscriptVersion(root)).rejects.toThrow(/unsafeWindow/u);
    await writeFile(script, metadata('unknown'));
    await expect(readBundledUserscriptVersion(root)).rejects.toThrow();
    await writeFile(
      script,
      metadata('0.45.8').replace('// @version 0.45.8', '// @version 0.45.8\n// @version 9.9.9')
    );
    await expect(readBundledUserscriptVersion(root)).rejects.toThrow(/one @version/u);
  });
  it('reads a packaged file at the size cap and rejects empty or oversized files', async () => {
    const { root } = await fixture();
    const file = join(root, 'resource.js');
    await writeFile(file, '1234');
    expect(await readBoundedPackagedResource(file, 'resource.js', 4)).toEqual(Buffer.from('1234'));
    await writeFile(file, '12345');
    await expect(readBoundedPackagedResource(file, 'resource.js', 4)).rejects.toThrow(
      'exceeds diagnostic body limit'
    );
    await writeFile(file, '');
    await expect(readBoundedPackagedResource(file, 'resource.js', 4)).rejects.toThrow(
      'or is empty'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a packaged symlink and a file replaced after opening',
    async () => {
      const { root } = await fixture();
      const file = join(root, 'resource.js');
      const replacement = join(root, 'replacement.js');
      const link = join(root, 'link.js');
      await writeFile(file, 'old!');
      await symlink(file, link);
      await expect(readBoundedPackagedResource(link, 'resource.js', 4)).rejects.toThrow();
      await writeFile(replacement, 'new!');
      await expect(
        readBoundedPackagedResource(file, 'resource.js', 4, {
          onOpened: () => rename(replacement, file),
        })
      ).rejects.toThrow('changed during inspection');
    }
  );

  it('accepts only two exact paths at the installed extension ID', () => {
    const id = 'a'.repeat(32);
    for (const path of ['workers/renderer.js', 'page-script.js']) {
      expect(ownedExtensionResourcePath(`chrome-extension://${id}/${path}`, id)).toBe(path);
      expect(
        ownedExtensionResourcePath(`chrome-extension://${id}/${path}?private=1`, id)
      ).toBeNull();
      expect(
        ownedExtensionResourcePath(`chrome-extension://${id}/${path}#fragment`, id)
      ).toBeNull();
      expect(
        ownedExtensionResourcePath(`chrome-extension://${'b'.repeat(32)}/${path}`, id)
      ).toBeNull();
    }
    expect(ownedExtensionResourcePath(`chrome-extension://${id}/workers/other.js`, id)).toBeNull();
    expect(ownedExtensionResourcePath(`https://${id}/page-script.js`, id)).toBeNull();
    expect(ownedExtensionResourcePath('not-a-url', id)).toBeNull();
  });

  it('correlates only bounded owned-resource warnings without recording URL secrets', () => {
    const id = 'a'.repeat(32);
    const frame = 'https://www.youtube.com/watch?v=private&sig=secret';
    const warning = `Unsafe attempt to load URL chrome-extension://${id}/workers/renderer.js from frame with URL ${frame}. Domains, protocols and ports must match.\n`;
    const link = diagnoseUnsafeOriginConsole(warning, frame, id);
    expect(link).toEqual({
      currentDocumentSha256: createHash('sha256').update(frame).digest('hex'),
      ownedResourcePath: 'workers/renderer.js',
      reportedFrameDocumentSha256: createHash('sha256').update(frame).digest('hex'),
    });
    expect(JSON.stringify(link)).not.toMatch(/private|secret/u);
    expect(
      diagnoseUnsafeOriginConsole(warning.replace('. Domains,', ' Domains,'), frame, id)
    ).toMatchObject({ reportedFrameDocumentSha256: null });
    expect(
      diagnoseUnsafeOriginConsole(
        warning.replace('workers/renderer.js', 'workers/other.js'),
        'https://www.youtube.com/watch?v=other',
        id
      )
    ).toMatchObject({ ownedResourcePath: null });
    expect(diagnoseUnsafeOriginConsole(warning.repeat(30), frame, id)).toMatchObject({
      ownedResourcePath: null,
      reportedFrameDocumentSha256: null,
    });
    const redacted = redactChromeDiagnosticText(
      `Unsafe https://user:credential@example.com/watch?v=private&sig=secret and chrome-extension://${id}/page-script.js?token=hidden`
    );
    expect(redacted).not.toMatch(/user|credential|private|secret|hidden|token=/u);
    expect(redacted).toContain('example.com/watch');
    expect(redacted.length).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(redactChromeDiagnosticText('🧪'.repeat(1000)))).toBeLessThanOrEqual(
      1000
    );
  });

  it('bounds and hashes only the exact packaged resource body', () => {
    const body = Buffer.from('owned resource');
    const expected = {
      maxBytes: body.length,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    expect(compareOwnedExtensionResourceBody(body, expected)).toMatchObject({
      status: 'matched',
      bytes: body.length,
      sha256: expected.sha256,
    });
    expect(
      compareOwnedExtensionResourceBody(Buffer.from('other resource'), expected)
    ).toMatchObject({
      status: 'unverified',
      reason: 'body-mismatch',
    });
    expect(compareOwnedExtensionResourceBody(Buffer.alloc(body.length + 1), expected)).toEqual({
      status: 'unverified',
      reason: 'body-overflow',
    });
  });

  it('records completed owned requests and removes its page listeners', async () => {
    const page = new EventEmitter();
    const id = 'a'.repeat(32);
    const expected: Record<string, { maxBytes: number; bytes: number; sha256: string }> = {};
    const resources = ['workers/renderer.js', 'page-script.js'];
    for (const path of resources) {
      const body = Buffer.from(path);
      expected[path] = {
        maxBytes: 100,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
    }
    let navigation = 'initial-watch';
    let observedAtMs = 0;
    const finish = beginOwnedExtensionResourceCapture(
      page as unknown as Page,
      id,
      expected,
      () => ({
        sourcePhase: 'navigation',
        navigation,
      }),
      () => observedAtMs
    );
    for (navigation of ['initial-watch', 'next-watch']) {
      for (const path of resources) {
        observedAtMs += 5;
        const body = Buffer.from(path);
        const request = {
          url: () => `chrome-extension://${id}/${path}`,
          frame: () => ({ url: () => `https://www.youtube.com/watch?v=${navigation}&sig=private` }),
          resourceType: () => (path === 'page-script.js' ? 'script' : 'fetch'),
          headers: () => ({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' }),
          sizes: async () => ({ responseBodySize: body.length }),
          response: async () => response,
        };
        const response = {
          request: () => request,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/javascript' }),
          body: async () => body,
        };
        page.emit('request', request);
        observedAtMs += 1;
        page.emit('response', response);
        observedAtMs += 1;
        page.emit('requestfinished', request);
      }
    }
    const result = await finish();
    expect(result).toMatchObject({
      status: 'observed',
      missing: [],
      missingByNavigation: { 'initial-watch': [], 'next-watch': [] },
      overflow: 0,
    });
    expect(result.requests).toHaveLength(4);
    expect(result.requests[0]).toMatchObject({
      documentUrl: 'https://www.youtube.com/watch',
      sourcePhase: 'navigation',
      status: 'matched',
      responseStatus: 200,
      requestedAtMs: 5,
      respondedAtMs: 6,
      finishedAtMs: 7,
      failedAtMs: null,
      resourceType: 'fetch',
      fetchMode: 'cors',
      fetchDest: 'script',
    });
    expect(result.requests[0]?.documentUrlSha256).not.toBe(result.requests[2]?.documentUrlSha256);
    expect(JSON.stringify(result)).not.toContain('private');
    for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) {
      expect(page.listenerCount(event)).toBe(0);
    }
  });

  it('records the bounded Playwright network failure reason for an owned resource', async () => {
    const page = new EventEmitter();
    const id = 'a'.repeat(32);
    const body = Buffer.from('resource');
    const expected = {
      'page-script.js': {
        maxBytes: 100,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    };
    const finish = beginOwnedExtensionResourceCapture(
      page as unknown as Page,
      id,
      expected,
      () => ({
        navigation: 'initial-watch',
      }),
      () => 999_999
    );
    const request = {
      url: () => `chrome-extension://${id}/page-script.js`,
      frame: () => ({ url: () => 'https://www.youtube.com/watch?v=private' }),
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
      resourceType: () => 'untrusted-type',
      headers: () => ({ 'sec-fetch-mode': 'private-mode', 'sec-fetch-dest': 'private-dest' }),
    };
    page.emit('request', request);
    page.emit('requestfailed', request);
    const result = await finish();
    expect(result.requests[0]).toMatchObject({
      status: 'unverified',
      reason: 'net::ERR_CONNECTION_RESET',
      requestedAtMs: 180_000,
      failedAtMs: 180_000,
      resourceType: null,
      fetchMode: null,
      fetchDest: null,
    });
  });

  it('keeps the owned request inventory capped when a page repeats one resource', async () => {
    const page = new EventEmitter();
    const id = 'a'.repeat(32);
    const finish = beginOwnedExtensionResourceCapture(
      page as unknown as Page,
      id,
      { 'page-script.js': { maxBytes: 1, bytes: 1, sha256: 'a'.repeat(64) } },
      () => ({ navigation: 'initial-watch' })
    );
    for (let index = 0; index < 17; index++) {
      page.emit('request', {
        url: () => `chrome-extension://${id}/page-script.js`,
        frame: () => ({ url: () => 'https://www.youtube.com/watch?v=private' }),
      });
    }
    const result = await finish();
    expect(result).toMatchObject({ status: 'unverified', overflow: 1 });
    expect(result.requests).toHaveLength(16);
  });

  it.each([
    ['https://accounts.google.com/ServiceLogin', true, false],
    ['https://consent.youtube.com/', false, true],
    ['https://consent.google.com/', false, true],
    ['https://www.youtube.com/watch?v=fixture&next=https://accounts.google.com/', false, false],
    ['https://www.youtube.com/watch?v=fixture&next=https://consent.youtube.com/', false, false],
    ['https://accounts.google.com.attacker.example/', false, false],
    ['https://consent.youtube.com.attacker.example/', false, false],
  ])(
    'classifies redirect hosts without matching URL content: %s',
    async (href, loginRedirect, consentRedirect) => {
      const page = {
        evaluate: async (read: () => unknown) =>
          runInNewContext(`(${read})()`, {
            window: {},
            location: { href },
            URL,
          }),
      };
      expect(await readPublicPageState(page as unknown as Page)).toMatchObject({
        loginRedirect,
        consentRedirect,
      });
    }
  );

  it('uses the shared seek calculation in the Chrome driver', () => {
    expect(selectPublicSeekTarget).toBe(liveRenderingModule.selectPublicSeekTarget);
    expect(selectPublicSeekTarget({ currentTime: 10, start: 0, end: 100 })).toBe(13);
  });

  it.each([
    [
      { Utilities: '도구', Install: '설치', Installed_userscripts: '설치된 유저 스크립트' },
      { utilities: '도구', install: '설치', installedUserscripts: '설치된 유저 스크립트' },
    ],
    [
      {
        Utilities: 'Utilities',
        Install: 'Install',
        Installed_userscripts: 'Installed Userscripts',
      },
      { utilities: 'Utilities', install: 'Install', installedUserscripts: 'Installed Userscripts' },
    ],
  ])('reads bundled manager labels from its owned options page: %j', async (messages, expected) => {
    const optionsUrl = 'chrome-extension://owned/options.html';
    const page = {
      url: () => optionsUrl,
      evaluate: async (read: (id: string) => unknown, id: string) =>
        runInNewContext(`(${read})(${JSON.stringify(id)})`, {
          URL,
          location: { href: optionsUrl },
          chrome: {
            i18n: { getMessage: (key: string) => messages[key as keyof typeof messages] ?? '' },
          },
        }),
    };
    expect(await readManagerUiLabels(page as unknown as Page, 'owned')).toEqual(expected);
  });

  it('rejects manager label lookup outside its owned options page and after navigation', async () => {
    const optionsUrl = 'chrome-extension://owned/options.html';
    for (const url of [
      'about:blank',
      'https://example.com/',
      'chrome-extension://other/options.html',
      'chrome-extension://owned/ask.html',
      'chrome-extension://owned/options.html?token=private',
    ]) {
      expect(isOwnedManagerOptionsUrl(url, 'owned')).toBe(false);
      const evaluate = vi.fn();
      await expect(
        readManagerUiLabels({ url: () => url, evaluate } as unknown as Page, 'owned')
      ).rejects.toThrow('owned options page');
      expect(evaluate).not.toHaveBeenCalled();
    }
    expect(isOwnedManagerOptionsUrl(optionsUrl, 'owned')).toBe(true);
    const evaluateFrom = (frameUrl: string) => (read: (id: string) => unknown, id: string) =>
      runInNewContext(`(${read})(${JSON.stringify(id)})`, {
        URL,
        location: { href: frameUrl },
        chrome: { i18n: { getMessage: () => 'label' } },
      });
    await expect(
      readManagerUiLabels(
        {
          url: () => optionsUrl,
          evaluate: evaluateFrom('https://example.com/'),
        } as unknown as Page,
        'owned'
      )
    ).rejects.toThrow('navigated away');
    let reportedUrl = optionsUrl;
    await expect(
      readManagerUiLabels(
        {
          url: () => reportedUrl,
          evaluate: (read: (id: string) => unknown, id: string) => {
            const labels = evaluateFrom(optionsUrl)(read, id);
            reportedUrl = 'chrome-extension://other/options.html';
            return labels;
          },
        } as unknown as Page,
        'owned'
      )
    ).rejects.toThrow('navigated away after label lookup');
  });

  it('requires three bounded manager UI labels', () => {
    const valid = {
      utilities: 'Utilities',
      install: 'Install',
      installedUserscripts: 'Installed Userscripts',
    };
    expect(requireManagerUiLabels(valid)).toEqual(valid);
    for (const labels of [
      null,
      [],
      { ...valid, utilities: '' },
      { ...valid, install: 'x'.repeat(81) },
      { ...valid, utilities: 'Tools\nother' },
      { ...valid, extra: 'unexpected' },
    ]) {
      expect(() => requireManagerUiLabels(labels)).toThrow();
    }
  });

  it('uses the visible Edge switch and its checked property, while keeping Chrome controls', async () => {
    for (const browserName of ['msedge', 'chrome']) {
      const visible = { checked: browserName === 'chrome', getAttribute: () => 'false' };
      const click = vi.fn(async () => {
        visible.checked = true;
      });
      const locator = vi.fn((selector: string) => {
        const expected = browserName === 'msedge' ? '#dev-switch:visible' : '#devMode';
        if (selector !== expected) throw new Error('Selected a hidden or unsupported toggle');
        return {
          waitFor: vi.fn(async () => {}),
          evaluate: async (read: (element: typeof visible) => boolean) => read(visible),
          click,
        };
      });
      const page = { goto: vi.fn(async () => {}), locator, close: vi.fn(async () => {}) };
      await enableDeveloperMode(
        { newPage: async () => page } as unknown as BrowserContext,
        browserName
      );
      expect(page.goto).toHaveBeenCalledWith(
        browserName === 'msedge' ? 'edge://extensions/' : 'chrome://extensions/'
      );
      expect(locator).toHaveBeenCalledWith(
        browserName === 'msedge' ? '#dev-switch:visible' : '#devMode'
      );
      expect(click).toHaveBeenCalledTimes(browserName === 'msedge' ? 1 : 0);
      expect(visible.checked).toBe(true);
      expect(page.close).toHaveBeenCalledOnce();
    }
  });

  it('rejects an Edge switch that remains disabled after clicking', async () => {
    const switchElement = { checked: false };
    const page = {
      goto: vi.fn(async () => {}),
      locator: vi.fn(() => ({
        waitFor: async () => {},
        evaluate: async (read: (element: typeof switchElement) => boolean) => read(switchElement),
        click: async () => {},
      })),
      close: vi.fn(async () => {}),
    };
    await expect(
      enableDeveloperMode({ newPage: async () => page } as unknown as BrowserContext, 'msedge')
    ).rejects.toThrow('Developer mode is disabled');
    expect(page.close).toHaveBeenCalledOnce();
  });

  it('requires an observed page-policy restriction before accepting extension main rendering', () => {
    const { validateLiveRenderer, countUnexpectedLiveErrors } = liveRenderingModule;
    const blocked = {
      type: 'error',
      text: "This document requires 'TrustedScriptURL' assignment. The action has been blocked.",
      url: 'chrome-extension://owned/page-script.js',
    };
    expect(validateLiveRenderer('worker', 'extension', [], true)).toEqual({
      renderer: 'worker',
      workerPolicyFallback: false,
    });
    expect(validateLiveRenderer('main', 'extension', [blocked], true)).toEqual({
      renderer: 'main',
      workerPolicyFallback: true,
    });
    expect(() => validateLiveRenderer('main', 'extension', [], true)).toThrow();
    expect(() => validateLiveRenderer('main', 'extension', [blocked], false)).toThrow();
    expect(() =>
      validateLiveRenderer('main', 'extension', [{ ...blocked, type: 'info' }], true)
    ).toThrow();
    expect(() =>
      validateLiveRenderer(
        'main',
        'extension',
        [{ ...blocked, url: 'https://www.youtube.com/host.js' }],
        true
      )
    ).toThrow();
    expect(() => validateLiveRenderer('unknown', 'extension', [blocked], true)).toThrow();
    expect(countUnexpectedLiveErrors([blocked], true)).toBe(0);
    expect(countUnexpectedLiveErrors([blocked], false)).toBe(1);
    expect(countUnexpectedLiveErrors([blocked, { type: 'error', text: 'app crashed' }], true)).toBe(
      1
    );
  });
  it('rejects a loaded page that did not render the installed application', () => {
    expect(() => requireLiveSuccess([{ status: 'unverified', canvasAttached: false }])).toThrow();
    expect(() =>
      requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 0 }])
    ).toThrow();
    expect(() =>
      requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 1 }])
    ).not.toThrow();
    expect(() =>
      requireLiveSuccess([
        {
          status: 'passed',
          canvasAttached: true,
          renderedMessages: 1,
          pageErrorTypes: ['TypeError'],
        },
      ])
    ).toThrow();
    expect(() =>
      requireLiveSuccess([
        { status: 'passed', canvasAttached: true, renderedMessages: 1, unexpectedConsoleErrors: 1 },
      ])
    ).toThrow();
  });
  it('separates only named native YouTube failures and removes signed URL queries', () => {
    const { isYouTubeHostError, countUnexpectedLiveErrors, redactDiagnosticText } =
      liveRenderingModule;
    const prefix =
      'Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at ';
    const host = {
      level: 'error',
      text: `${prefix}https://rr1.googlevideo.com/videoplayback?sig=private`,
    };
    expect(isYouTubeHostError(host)).toBe(true);
    expect(
      isYouTubeHostError({
        type: 'error',
        text: 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED',
        url: 'https://rr1.googlevideo.com/videoplayback',
      })
    ).toBe(true);
    expect(
      isYouTubeHostError({
        type: 'error',
        text: 'Failed to load resource: 401',
        url: 'https://accounts.google.com/ServiceLogin',
      })
    ).toBe(true);
    expect(
      isYouTubeHostError({
        type: 'error',
        text: "Access to fetch at 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123/?id=x' from origin 'https://www.youtube.com' has been blocked by CORS policy.",
      })
    ).toBe(true);
    expect(
      isYouTubeHostError({
        type: 'error',
        text: 'Failed to load resource: 500',
        url: 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat',
      })
    ).toBe(false);
    expect(
      isYouTubeHostError({
        ...host,
        text: `${prefix}https://www.youtube.com/youtubei/v1/live_chat/get_live_chat`,
      })
    ).toBe(false);
    expect(
      isYouTubeHostError({
        ...host,
        text: `${prefix}https://googlevideo.com.attacker.example/videoplayback`,
      })
    ).toBe(false);
    expect(
      countUnexpectedLiveErrors([host, { level: 'error', text: '[Youtubei] app failed' }], false)
    ).toBe(1);
    expect(redactDiagnosticText(host.text)).not.toContain('sig=');
  });

  it('accepts one exact browser process identity from the browser CDP session', () => {
    expect(
      readOwnedBrowserProcessId({
        processInfo: [
          { id: 123, type: 'renderer' },
          { id: 456, type: 'browser' },
        ],
      })
    ).toBe(456);
    expect(() => readOwnedBrowserProcessId({ processInfo: [] })).toThrow();
    expect(() =>
      readOwnedBrowserProcessId({
        processInfo: [
          { id: 1, type: 'browser' },
          { id: 2, type: 'browser' },
        ],
      })
    ).toThrow();
  });

  it('still closes the browser and removes its profile when uninstall fails', async () => {
    const paths = await fixture();
    const close = vi.fn(async () => {});
    const result = { cleanup: {} };
    await expect(
      cleanupChromeInstallation({
        context: { close },
        cdp: {
          send: async () => {
            throw new Error('uninstall failed');
          },
        },
        extensionId: 'owned',
        ...paths,
        result,
      })
    ).rejects.toThrow(AggregateError);
    expect(close).toHaveBeenCalledOnce();
    await expect(stat(paths.profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(paths.root, 'keep'), 'utf8')).toBe('unrelated fixture');
    const evidence = JSON.parse(
      await readFile(join(paths.output, 'installation-result.json'), 'utf8')
    );
    expect(evidence.cleanup).toMatchObject({
      browserClosed: true,
      profileRemoved: true,
      errorCount: 1,
      errorTypes: [{ stage: 'extension-uninstall', errorType: 'Error' }],
    });
  });

  it('attempts the owned browser fallback and profile removal after context close fails', async () => {
    const paths = await fixture();
    const browserClose = vi.fn(async () => {});
    const result = { cleanup: {} };
    await expect(
      cleanupChromeInstallation({
        context: {
          close: async () => {
            throw new Error('context failed');
          },
          browser: () => ({ close: browserClose }),
        },
        cdp: null,
        extensionId: null,
        ...paths,
        result,
      })
    ).rejects.toThrow(AggregateError);
    expect(browserClose).toHaveBeenCalledOnce();
    await expect(stat(paths.profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.cleanup).toMatchObject({
      browserClosed: true,
      profileRemoved: true,
      errorCount: 1,
      errorTypes: [{ stage: 'context-close', errorType: 'Error' }],
    });
  });

  it('terminates only the retained browser tree when both Playwright closes fail', async () => {
    const paths = await fixture();
    const terminateProcessTree = vi.fn(async () => {});
    const checkProcessAlive = vi.fn().mockResolvedValue(true);
    const result = { cleanup: {} };
    await expect(
      cleanupChromeInstallation(
        {
          browserProcessId: 456,
          context: {
            close: async () => {
              throw new Error('context failed');
            },
            browser: () => ({
              close: async () => {
                throw new Error('browser failed');
              },
            }),
          },
          cdp: null,
          extensionId: null,
          ...paths,
          result,
          root: paths.root,
        },
        {
          checkProcessAlive,
          terminateProcessTree,
          waitForExit: vi.fn().mockResolvedValue(true),
        }
      )
    ).rejects.toThrow(AggregateError);

    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(456);
    await expect(stat(paths.profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.cleanup).toMatchObject({
      browserProcessExited: true,
      profileRemoved: true,
      errorCount: 2,
      errorTypes: [
        { stage: 'context-close', errorType: 'Error' },
        { stage: 'browser-close', errorType: 'Error' },
      ],
    });
  });

  it('preserves the owned profile when browser-tree termination cannot be proven', async () => {
    const paths = await fixture();
    const terminateProcessTree = vi.fn(async () => {
      throw new Error('tree remains');
    });
    const result = { cleanup: {} };
    await expect(
      cleanupChromeInstallation(
        {
          browserProcessId: 789,
          context: {
            close: async () => {
              throw new Error('context failed');
            },
            browser: () => ({
              close: async () => {
                throw new Error('browser failed');
              },
            }),
          },
          cdp: null,
          extensionId: null,
          ...paths,
          result,
          root: paths.root,
        },
        {
          checkProcessAlive: vi.fn().mockResolvedValue(true),
          terminateProcessTree,
          waitForExit: vi.fn().mockResolvedValue(false),
        }
      )
    ).rejects.toThrow(AggregateError);

    expect(terminateProcessTree).toHaveBeenCalledWith(789);
    expect(await stat(paths.profile)).toBeDefined();
    expect(result.cleanup).toMatchObject({ profilePreserved: true, browserProcessExited: false });
    const evidence = JSON.parse(
      await readFile(join(paths.output, 'installation-result.json'), 'utf8')
    );
    expect(evidence.cleanup).toMatchObject({
      browserProcessExited: false,
      profilePreserved: true,
    });
  });
});
