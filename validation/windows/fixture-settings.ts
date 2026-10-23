// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { BrowserContext, Page } from '@playwright/test';

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture settings restoration timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Restore settings durably before retiring an owned installed-extension page. */
export async function restoreFixtureSettings(
  context: BrowserContext,
  page: Page,
  extensionId: string,
  settings: ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>
): Promise<void> {
  await within(
    page.evaluate(async (previous) => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed app disappeared before settings restoration');
      app.applySettings(previous);
      // stop() flushes the debounced save and awaits any earlier storage write.
      await app.stop();
    }, settings)
  );
  const worker = context
    .serviceWorkers()
    .find((candidate) => candidate.url().startsWith(`chrome-extension://${extensionId}/`));
  assert(worker, 'Installed extension background worker is unavailable for settings readback');
  const saved = await within(
    worker.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          chrome: {
            storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
          };
        }
      ).chrome;
      return (await api.storage.local.get('yt-live-chat-overlay-settings'))[
        'yt-live-chat-overlay-settings'
      ];
    })
  );
  assert.equal(typeof saved, 'string', 'Restored extension settings were not persisted');
  const stored: unknown = JSON.parse(saved as string);
  assert(stored && typeof stored === 'object' && !Array.isArray(stored));
  const values = stored as Record<string, unknown>;
  assert.deepEqual(
    Object.fromEntries(Object.keys(settings).map((key) => [key, values[key]])),
    settings,
    'Installed extension settings leaked from the retired fixture'
  );
}
