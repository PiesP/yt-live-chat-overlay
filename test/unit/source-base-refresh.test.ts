// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import type { ChatBootstrapData } from '@chat/youtube/api';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { describe, expect, it, vi } from 'vite-plus/test';

import { observeTrace } from './chat/replay-admission-model';

const mocks = vi.hoisted(() => ({
  refreshBootstrap: vi.fn(),
  resolveBootstrap: vi.fn(),
}));

vi.mock('@app/bootstrap-resolver', () => ({
  logBootstrapFailure: vi.fn(),
  refreshBootstrap: mocks.refreshBootstrap,
  resolveBootstrap: mocks.resolveBootstrap,
}));

import { ChatSession, type ChatProtocolOperations } from '@chat/source-base';

function createSession(): { session: ChatSession; context: ChatProtocolOperations } {
  let context: ChatProtocolOperations | undefined;
  const session = new ChatSession(
    () => DEFAULT_SETTINGS as OverlaySettings,
    (operations) => {
      context = operations;
      return {
        scheduling: 'independent',
        reset: () => {},
        seed: async () => true,
        launch: () => {},
        isObserverAlive: () => false,
      };
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
    expect(context.getBootstrap()).toBe(original);
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
    expect(context.getBootstrap()).toBe(replacement);
    session.stop();
  });
});

describe('ChatSession poll-owner retirement', () => {
  it('keeps the replacement observer alive after an old loop actually completes', async () => {
    const oldRun = Promise.withResolvers<void>();
    const replacementRun = Promise.withResolvers<void>();
    const run = vi
      .fn<(signal?: AbortSignal) => Promise<void>>()
      .mockReturnValueOnce(oldRun.promise)
      .mockReturnValueOnce(replacementRun.promise);
    const session = new ChatSession(
      () => DEFAULT_SETTINGS,
      () => ({
        scheduling: 'poll-loop',
        reset: () => {},
        seed: async () => true,
        run,
      })
    );
    const bootstrap: ChatBootstrapData = {
      videoId: 'video',
      isReplay: false,
      clientContext: {},
      clientNameHeader: '1',
      ytcfg: {},
      initialContinuation: { continuation: 'initial' },
    };

    try {
      session.setInitialBootstrap(bootstrap);
      await expect(session.start(vi.fn())).resolves.toBe('started');
      expect(session.getHealthSnapshot().observerAlive).toBe(true);

      session.setInitialBootstrap(bootstrap);
      await expect(session.start(vi.fn())).resolves.toBe('started');
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[0]?.[0]?.aborted).toBe(true);
      expect(run.mock.calls[1]?.[0]?.aborted).toBe(false);

      oldRun.resolve();
      await oldRun.promise;
      const finished = observeTrace(['stop', 'start', 'old-success', 'old-loop-finish'], 'session');
      expect(session.getHealthSnapshot().observerAlive).toBe(finished.observer === 1);
    } finally {
      session.stop();
      oldRun.resolve();
      replacementRun.resolve();
    }
  });
});
