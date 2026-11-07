// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import type { ChatBootstrapData } from '@chat/youtube/api';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  refreshBootstrap: vi.fn(),
  resolveBootstrap: vi.fn(),
}));

vi.mock('@app/bootstrap-resolver', () => ({
  logBootstrapFailure: vi.fn(),
  refreshBootstrap: mocks.refreshBootstrap,
  resolveBootstrap: mocks.resolveBootstrap,
}));

import { ChatSession, type ChatDriverContext } from '@chat/source-base';

function createSession(): { session: ChatSession; context: ChatDriverContext } {
  let context: ChatDriverContext | undefined;
  const session = new ChatSession(
    () => DEFAULT_SETTINGS as OverlaySettings,
    (operations) => {
      context = operations;
      return { reset: () => {}, seed: async () => true, launch: () => {} };
    }
  );
  if (!context) throw new Error('Session context was not created');
  return { session, context };
}

describe('ChatSession bootstrap refresh', () => {
  it('does not replace a valid bootstrap with a rejected refresh candidate', async () => {
    const { session, context } = createSession();
    const original = { isReplay: true } as ChatBootstrapData;
    const invalid = { isReplay: false } as ChatBootstrapData;
    session.setInitialBootstrap(original);
    mocks.refreshBootstrap.mockResolvedValue(invalid);

    await expect(
      context.refreshBootstrap(undefined, (candidate) => candidate.isReplay)
    ).resolves.toBeNull();
    expect(context.bootstrap()).toBe(original);
  });

  it('rejects a late resolver result after a replacement start consumes its preseed', async () => {
    let resolveOld: ((result: { status: 'ready'; data: ChatBootstrapData }) => void) | undefined;
    mocks.resolveBootstrap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const { session, context } = createSession();
    const oldStart = session.start(() => {});
    const replacement = { isReplay: false } as ChatBootstrapData;
    session.setInitialBootstrap(replacement);

    await expect(session.start(() => {})).resolves.toBe('started');
    resolveOld?.({ status: 'ready', data: { isReplay: true } as ChatBootstrapData });
    await expect(oldStart).resolves.toBe('retryable');
    expect(context.bootstrap()).toBe(replacement);
    session.stop();
  });
});
