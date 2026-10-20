// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import type { BrowserContext } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  assertInstrumentedPageScript,
  installNativePageScriptProbe,
} from '../../../validation/windows/native-page-script-probe.ts';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const fixtureUrl = 'https://www.youtube.com/watch?v=probeFixture';
const documentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const marker = '\n\tmain();\n';
const base = `(function() {
  function main() { window.appStarted = true; }${marker}})();\n`;
const instrumented = base.replace(marker, `\n\twindow.probeAttached = true;${marker}`);

describe('native page-script fixture adapter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'yt-native-page-probe-'));
    roots.push(root);
    await mkdir(join(root, 'dist-extension'));
    await writeFile(join(root, 'dist-extension/page-script.js'), base);

    const window = { appStarted: false, probeAttached: false };
    let tabUrl: string | undefined = fixtureUrl;
    let packagedSource = base;
    let loseInstallResponse = false;
    let loseRestoreResponse = false;
    const original = vi.fn(
      async (injection: {
        target: { documentIds: string[] };
        func?: () => void;
        world?: string;
        files?: string[];
      }) => {
        injection.func?.();
        return [{ documentId: injection.target.documentIds[0], frameId: 0 }];
      }
    );
    const scripting = { executeScript: original };
    const chrome = {
      runtime: {
        id: extensionId,
        getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      },
      scripting,
      tabs: { get: async () => ({ url: tabUrl }) },
    };
    const sandbox = createContext({
      chrome,
      crypto: webcrypto,
      fetch: async () => ({ ok: true, text: async () => packagedSource }),
      TextEncoder,
      window,
    });
    const worker = {
      url: () => `chrome-extension://${extensionId}/background.js`,
      evaluate: async (expression: string) => {
        const value: unknown = await runInContext(expression, sandbox);
        if (loseInstallResponse && expression.includes('const probeFunction =')) {
          loseInstallResponse = false;
          throw new Error('CDP install response lost');
        }
        if (loseRestoreResponse && expression.includes('const receiptKey =')) {
          loseRestoreResponse = false;
          throw new Error('CDP restore response lost');
        }
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      },
    };
    const context = { serviceWorkers: () => [worker] } as unknown as BrowserContext;
    const install = () =>
      installNativePageScriptProbe({
        context,
        root,
        extensionId,
        fixtureUrl,
        instrumentedSource: instrumented,
      });
    return {
      context,
      install,
      original,
      scripting,
      window,
      setTabUrl: (url: string | undefined) => {
        tabUrl = url;
      },
      setPackagedSource: (source: string) => {
        packagedSource = source;
      },
      loseNextInstallResponse: () => {
        loseInstallResponse = true;
      },
      loseNextRestoreResponse: () => {
        loseRestoreResponse = true;
      },
      restart: () => {
        runInContext(
          'delete globalThis.__ytWindowsNativePageScriptProbe; delete globalThis.__ytWindowsNativePageScriptProbeGeneration',
          sandbox
        );
        scripting.executeScript = original;
      },
      dropState: () => runInContext('delete globalThis.__ytWindowsNativePageScriptProbe', sandbox),
      transferOwnership: () =>
        runInContext('globalThis.__ytWindowsNativePageScriptProbe.token = "foreign"', sandbox),
    };
  }

  it('accepts only a bounded insertion at the compiled entry point', () => {
    expect(() => assertInstrumentedPageScript(base, instrumented)).not.toThrow();
    expect(() => assertInstrumentedPageScript(base, base)).toThrow();
    expect(() =>
      assertInstrumentedPageScript(base, instrumented.replace('main()', 'other()'))
    ).toThrow();
  });

  it('replaces one exact document injection and restores its owned wrapper', async () => {
    const harness = await fixture();
    const probe = await harness.install();
    await probe.assertReady();
    const request = {
      target: { tabId: 42, documentIds: [documentId] },
      world: 'MAIN',
      files: ['page-script.js'],
    };
    await harness.scripting.executeScript(request);
    await probe.assertInjected();
    expect(harness.window).toEqual({ appStarted: true, probeAttached: true });
    expect(harness.original).toHaveBeenCalledWith({
      target: request.target,
      world: 'MAIN',
      func: expect.any(Function),
    });
    await expect(harness.scripting.executeScript(request)).rejects.toThrow('reused');
    await probe.restore();
    assert.equal(harness.scripting.executeScript, harness.original);
  });

  it('passes a non-fixture tab through without claiming probe success', async () => {
    const harness = await fixture();
    harness.setTabUrl('https://www.youtube.com/watch?v=other');
    const probe = await harness.install();
    const request = {
      target: { tabId: 42, documentIds: [documentId] },
      world: 'MAIN',
      files: ['page-script.js'],
    };
    await harness.scripting.executeScript(request);
    expect(harness.original).toHaveBeenCalledWith(request);
    await expect(probe.assertInjected()).rejects.toThrow('did not replace exactly one');
    await probe.restore();
  });

  it('fails closed on a missing tab URL or changed injection contract', async () => {
    const harness = await fixture();
    const probe = await harness.install();
    const request = {
      target: { tabId: 42, documentIds: [documentId] },
      world: 'MAIN',
      files: ['page-script.js'],
    };
    harness.setTabUrl(undefined);
    await expect(harness.scripting.executeScript(request)).rejects.toThrow(
      'tab URL is unavailable'
    );
    harness.setTabUrl(fixtureUrl);
    await expect(
      harness.scripting.executeScript({ ...request, world: 'ISOLATED' })
    ).rejects.toThrow('injection contract changed');
    expect(harness.original).not.toHaveBeenCalled();
    await probe.restore();
  });

  it('refuses a mismatched packaged script and a second wrapper', async () => {
    const harness = await fixture();
    harness.setPackagedSource(`${base}\nchanged`);
    await expect(harness.install()).rejects.toThrow('differs from the fixture source');
    harness.setPackagedSource(base);
    const probe = await harness.install();
    await expect(harness.install()).rejects.toThrow('already installed');
    await probe.restore();
  });

  it('reports lost ownership after a simulated MV3 worker restart', async () => {
    const harness = await fixture();
    const probe = await harness.install();
    harness.restart();
    // The same Playwright Worker handle can point at a fresh global context.
    await expect(probe.assertReady()).rejects.toThrow('worker generation was lost');
    await expect(probe.restore()).rejects.toThrow('cleanup not verified: generation-lost');
  });

  it('distinguishes an absent owned state from a restarted worker', async () => {
    const harness = await fixture();
    const probe = await harness.install();
    harness.dropState();
    await expect(probe.restore()).rejects.toThrow('cleanup not verified: absent');
  });

  it('leaves a foreign wrapper untouched during cleanup', async () => {
    const harness = await fixture();
    const probe = await harness.install();
    const wrapper = harness.scripting.executeScript;
    harness.transferOwnership();
    await expect(probe.restore()).rejects.toThrow('cleanup not verified: foreign');
    expect(harness.scripting.executeScript).toBe(wrapper);
  });

  it('restores its owned wrapper when the install response is lost', async () => {
    const harness = await fixture();
    harness.loseNextInstallResponse();
    await expect(harness.install()).rejects.toThrow('CDP install response lost; cleanup=restored');
    expect(harness.scripting.executeScript).toBe(harness.original);
    const next = await harness.install();
    await next.assertReady();
    await next.restore();
  });

  it('accepts an owned restoration when only its CDP response is lost', async () => {
    const harness = await fixture();
    const probe = await harness.install();
    harness.loseNextRestoreResponse();
    await expect(probe.restore()).rejects.toThrow('CDP restore response lost');
    expect(harness.scripting.executeScript).toBe(harness.original);
    await expect(probe.restore()).resolves.toBeUndefined();
  });
});
