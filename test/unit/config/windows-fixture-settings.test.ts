// SPDX-License-Identifier: MIT

import { runInNewContext } from 'node:vm';

import type { BrowserContext, Page } from '@playwright/test';
import { DEFAULT_SETTINGS } from '@settings/defaults';
import { describe, expect, it } from 'vite-plus/test';

import { restoreFixtureSettings } from '../../../validation/windows/fixture-settings.ts';

function fixture(options: { closeFails?: boolean; applyFails?: boolean } = {}) {
  const original = { ...DEFAULT_SETTINGS, opacity: 0.75 };
  const draft = { ...original, opacity: 0.5 };
  let current = draft;
  let stored = JSON.stringify(draft);
  let open = true;
  const events: string[] = [];
  const button = {
    click() {
      events.push('close');
      if (options.closeFails) throw new Error('close failed');
      current = draft;
      stored = JSON.stringify(current);
      open = false;
      dialog.open = false;
    },
  };
  const dialog = { open: true, querySelector: () => button };
  const app = {
    applySettings(value: typeof original) {
      events.push('apply');
      if (options.applyFails) throw new Error('apply failed');
      current = value;
    },
    async stop() {
      events.push('stop');
      if (open) current = draft;
      stored = JSON.stringify(current);
    },
  };
  const scope = {
    window: { __ytChatOverlay: app },
    document: { querySelector: () => (open ? dialog : null) },
    chrome: {
      storage: {
        local: {
          get: async () => {
            events.push('readback');
            return { 'yt-live-chat-overlay-settings': stored };
          },
        },
      },
    },
  };
  const evaluate = async (fn: (...args: never[]) => unknown, arg?: unknown) =>
    runInNewContext(`(${fn.toString()})(argument)`, { ...scope, argument: arg });
  const page = { evaluate } as unknown as Page;
  const worker = { url: () => 'chrome-extension://fixture/background.js', evaluate };
  const context = { serviceWorkers: () => [worker] } as unknown as BrowserContext;
  return { original, context, page, events };
}

describe('installed fixture settings cleanup', () => {
  it('closes an open draft before restoring the original and stopping the app', async () => {
    const f = fixture();
    await restoreFixtureSettings(f.context, f.page, 'fixture', f.original);
    expect(f.events).toEqual(['close', 'apply', 'stop', 'readback']);
  });

  it('attempts restoration and readback even when closing and applying fail', async () => {
    const f = fixture({ closeFails: true, applyFails: true });
    await expect(restoreFixtureSettings(f.context, f.page, 'fixture', f.original)).rejects.toThrow(
      /close failed.*apply failed/s
    );
    expect(f.events).toEqual(['close', 'apply', 'stop', 'readback']);
  });

  it('reports both a failed close and the resulting unsuccessful readback', async () => {
    const f = fixture({ closeFails: true });
    await expect(restoreFixtureSettings(f.context, f.page, 'fixture', f.original)).rejects.toThrow(
      /close failed.*settings leaked/s
    );
    expect(f.events).toEqual(['close', 'apply', 'stop', 'readback']);
  });
});
