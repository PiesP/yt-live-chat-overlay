// SPDX-License-Identifier: MIT

import { runInNewContext } from 'node:vm';

import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vite-plus/test';

import { readPublicPageState as readChromePublicPageState } from '../../../validation/windows/chrome-install.ts';
import { readPublicPageState as readFirefoxPublicPageState } from '../../../validation/windows/firefox-install.ts';

type BrowserFixture = {
  href: string;
  initialData?: Record<string, unknown>;
  playabilityStatus?: string;
};

function adapters({ href, initialData, playabilityStatus }: BrowserFixture) {
  const context = () => ({
    window: {
      ytInitialData: initialData,
      ytInitialPlayerResponse: { playabilityStatus: { status: playabilityStatus } },
    },
    location: { href },
    URL,
  });
  const evaluate = vi.fn(async (probe: () => unknown) =>
    runInNewContext(`(${probe.toString()})()`, context())
  );
  const evaluateJson = vi.fn(async (expression: string) => runInNewContext(expression, context()));
  return {
    chrome: () => readChromePublicPageState({ evaluate } as unknown as Page),
    firefox: () =>
      readFirefoxPublicPageState({ evaluateJson } as unknown as Parameters<
        typeof readFirefoxPublicPageState
      >[0]),
    evaluate,
    evaluateJson,
  };
}

describe('shared browser public-page probe', () => {
  it.each([
    {
      name: 'nested live renderer',
      initialData: {
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: { liveChatRenderer: { continuations: [{}] } },
          },
        },
      },
      mode: 'live',
    },
    {
      name: 'nested replay renderer',
      initialData: {
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: { liveChatRenderer: { isReplay: true, continuations: [{}] } },
          },
        },
      },
      mode: 'replay',
    },
    {
      name: 'fallback replay renderer',
      initialData: {
        other: { deep: { liveChatRenderer: { isReplay: true, continuations: [{}] } } },
      },
      mode: 'replay',
    },
    { name: 'missing renderer', initialData: {}, mode: 'unknown' },
  ])('executes both native adapters for $name', async ({ initialData, mode }) => {
    const href = 'https://www.youtube.com/watch?v=public&token=private';
    const fixture = adapters({ href, initialData, playabilityStatus: 'OK' });
    const chrome = await fixture.chrome();
    const firefox = await fixture.firefox();
    expect(chrome).toMatchObject({
      chatMode: mode,
      chatRendererFound: mode !== 'unknown',
      playabilityStatus: 'OK',
      loginRedirect: false,
      consentRedirect: false,
    });
    expect(firefox).toEqual({ ...chrome, finalUrl: href });
    expect(fixture.evaluate).toHaveBeenCalledOnce();
    expect(fixture.evaluateJson).toHaveBeenCalledOnce();
  });

  it.each([
    ['https://accounts.google.com/ServiceLogin', true, false],
    ['https://consent.youtube.com/', false, true],
    ['https://consent.google.com/', false, true],
    ['https://accounts.google.com.attacker.example/', false, false],
  ])('classifies the final hostname for %s', async (href, loginRedirect, consentRedirect) => {
    const fixture = adapters({ href, playabilityStatus: 'UNPLAYABLE' });
    expect(await fixture.chrome()).toMatchObject({
      loginRedirect,
      consentRedirect,
      playabilityStatus: 'UNPLAYABLE',
    });
    expect(await fixture.firefox()).toMatchObject({
      finalUrl: href,
      loginRedirect,
      consentRedirect,
    });
  });

  it('terminates a cyclic search and bounds traversal to 1,000 objects', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicFixture = adapters({
      href: 'https://www.youtube.com/watch?v=public',
      initialData: cyclic,
    });
    expect(await cyclicFixture.chrome()).toMatchObject({
      chatMode: 'unknown',
      chatRendererFound: false,
    });
    expect(await cyclicFixture.firefox()).toMatchObject({
      chatMode: 'unknown',
      chatRendererFound: false,
    });

    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let index = 0; index < 1_001; index++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.liveChatRenderer = { continuations: [{}] };
    const boundedFixture = adapters({
      href: 'https://www.youtube.com/watch?v=public',
      initialData: tooDeep,
    });
    expect(await boundedFixture.chrome()).toMatchObject({
      chatMode: 'unknown',
      chatRendererFound: false,
    });
    expect(await boundedFixture.firefox()).toMatchObject({
      chatMode: 'unknown',
      chatRendererFound: false,
    });
  });

  it('keeps Chrome fallback and Firefox propagation on evaluation failure', async () => {
    const fixture = adapters({ href: 'not-a-url' });
    expect(await fixture.chrome()).toEqual({
      chatMode: 'unknown',
      chatRendererFound: false,
      playabilityStatus: null,
      loginRedirect: false,
      consentRedirect: false,
    });
    await expect(fixture.firefox()).rejects.toThrow();
  });
});
