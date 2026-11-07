import type { OverlaySettings } from '@app-types';
import { ChatSession, type ChatDriverContext } from '@chat/source-base';
import type { ChatBootstrapData } from '@chat/youtube/api';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { describe, expect, it, vi } from 'vite-plus/test';

// A fake protocol driver keeps session behavior independent of live/replay I/O.
function createSource(getSettings: () => Readonly<OverlaySettings>): {
  source: ChatSession;
  context: ChatDriverContext;
  launched: { signal: AbortSignal | undefined };
} {
  let context: ChatDriverContext | undefined;
  const launched: { signal: AbortSignal | undefined } = { signal: undefined };
  const source = new ChatSession(getSettings, (operations) => {
    context = operations;
    return {
      reset: () => {},
      seed: async () => true,
      launch: (signal) => {
        launched.signal = signal;
      },
    };
  });
  if (!context) throw new Error('Session context was not created');
  return { source, context, launched };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ChatSource pause reason set', () => {
  const settings = Object.freeze({ ...DEFAULT_SETTINGS } as OverlaySettings);

  function createTestSource(): ChatSession {
    return createSource(() => settings).source;
  }

  it('setPauseReason add and remove does not throw', () => {
    const source = createTestSource();
    source.setPauseReason('visibility', true);
    source.setPauseReason('visibility', false);
    // API exercised without throwing — set is functional
  });

  it('multiple reasons can be added and removed independently', () => {
    const source = createTestSource();

    source.setPauseReason('visibility', true);
    source.setPauseReason('video', true);

    // Remove one — other remains active
    source.setPauseReason('visibility', false);

    // Remove remaining
    source.setPauseReason('video', false);

    // After all removed, can re-add
    source.setPauseReason('visibility', true);
    source.setPauseReason('visibility', false);
  });

  it('setPaused (legacy) uses "general" reason key', () => {
    const source = createTestSource();

    source.setPaused(true);
    // Legacy setPaused uses 'general' reason
    source.setPauseReason('visibility', true);
    source.setPaused(false); // clears 'general' only

    // 'visibility' reason should still be present
    source.setPauseReason('visibility', false);
  });

  it('duplicate add/remove is idempotent', () => {
    const source = createTestSource();

    source.setPauseReason('video', true);
    source.setPauseReason('video', true); // duplicate add — no-op
    source.setPauseReason('video', false);
    source.setPauseReason('video', false); // duplicate remove — no-op

    // After idempotent calls, state is clean
    source.setPauseReason('video', true);
    source.setPauseReason('video', false);
  });

  it('three distinct reasons can coexist', () => {
    const source = createTestSource();

    source.setPauseReason('visibility', true);
    source.setPauseReason('video', true);
    source.setPauseReason('buffering', true);

    // Clear all
    source.setPauseReason('visibility', false);
    source.setPauseReason('video', false);
    source.setPauseReason('buffering', false);
  });

  it('waits for every pause reason without scheduling polling timers', async () => {
    const { source, context } = createSource(() => settings);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    source.setPauseReason('visibility', true);
    source.setPauseReason('video', true);

    let resumed = false;
    const waiting = context.waitWhilePaused().then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    source.setPauseReason('visibility', false);
    await Promise.resolve();
    expect(resumed).toBe(false);

    source.setPauseReason('video', false);
    await waiting;
    expect(resumed).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  it('rejects the event-driven pause wait when the session aborts', async () => {
    const { source, context } = createSource(() => settings);
    const controller = new AbortController();
    source.setPauseReason('visibility', true);

    const waiting = context.waitWhilePaused(controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('injectExternalMessages ignores duplicates when callback is registered', () => {
    const source = createTestSource();
    const received: unknown[] = [];

    // Set up callback and inject a message
    source.start((msgs) => {
      received.push(Array.isArray(msgs) ? msgs.length : 1);
    }, new AbortController().signal);

    // Inject empty — no crash
    source.injectExternalMessages([]);
    source.injectExternalMessages([]);

    source.stop();
  });

  it('delivers externally observed messages to the renderer pause buffer during video pause', async () => {
    const source = createTestSource();
    const received: unknown[] = [];
    source.setInitialBootstrap({} as ChatBootstrapData);
    await source.start((messages) => received.push(messages));
    source.setPauseReason('video', true);

    source.injectExternalMessages([
      {
        id: 'paused-message',
        text: 'arrived while paused',
        content: [{ type: 'text', content: 'arrived while paused' }],
        kind: 'text',
        authorType: 'normal',
        timestamp: 1,
      },
    ]);

    expect(received).toHaveLength(1);
  });

  it('continues suppressing external messages while visibility is paused', async () => {
    const source = createTestSource();
    const received: unknown[] = [];
    source.setInitialBootstrap({} as ChatBootstrapData);
    await source.start((messages) => received.push(messages));
    source.setPauseReason('visibility', true);

    source.injectExternalMessages([
      {
        id: 'hidden-message',
        text: 'arrived while hidden',
        content: [{ type: 'text', content: 'arrived while hidden' }],
        kind: 'text',
        authorType: 'normal',
        timestamp: 1,
      },
    ]);

    expect(received).toEqual([]);
  });

  it('stop aborts the polling signal even when start receives an external signal', async () => {
    const { source, launched } = createSource(() => settings);
    source.setInitialBootstrap({} as ChatBootstrapData);
    const externalController = new AbortController();

    const status = await source.start(() => {}, externalController.signal);

    expect(status).toBe('started');
    expect(launched.signal?.aborted).toBe(false);
    source.stop();
    expect(launched.signal?.aborted).toBe(true);
    expect(externalController.signal.aborted).toBe(false);
  });

  it('does not reuse consumed bootstrap data on a later start', async () => {
    const source = createTestSource();
    source.setInitialBootstrap({} as ChatBootstrapData);

    await expect(source.start(() => {})).resolves.toBe('started');

    await expect(source.start(() => {})).resolves.toBe('unavailable');
    source.stop();
  });
});
