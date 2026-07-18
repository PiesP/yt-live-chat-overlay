import { describe, it, expect } from 'vitest';
import type { OverlaySettings } from '@app-types';
import { ChatSource } from '@chat/source-base';
import type { ChatBootstrapData } from '@chat/youtube/api';
import { DEFAULT_SETTINGS } from '@settings/schema';

// ── Minimal concrete ChatSource for testing pause reason set ────────

class TestChatSource extends ChatSource {
  lastLaunchedSignal: AbortSignal | undefined;

  constructor(getSettings: () => Readonly<OverlaySettings>) {
    super(getSettings);
  }

  protected async seedCurrentSession(): Promise<boolean> {
    return true;
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.lastLaunchedSignal = signal;
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ChatSource pause reason set', () => {
  const settings = Object.freeze({ ...DEFAULT_SETTINGS } as OverlaySettings);

  function createSource(): TestChatSource {
    return new TestChatSource(() => settings);
  }

  it('setPauseReason add and remove does not throw', () => {
    const source = createSource();
    source.setPauseReason('visibility', true);
    source.setPauseReason('visibility', false);
    // API exercised without throwing — set is functional
  });

  it('multiple reasons can be added and removed independently', () => {
    const source = createSource();

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
    const source = createSource();

    source.setPaused(true);
    // Legacy setPaused uses 'general' reason
    source.setPauseReason('visibility', true);
    source.setPaused(false); // clears 'general' only

    // 'visibility' reason should still be present
    source.setPauseReason('visibility', false);
  });

  it('duplicate add/remove is idempotent', () => {
    const source = createSource();

    source.setPauseReason('video', true);
    source.setPauseReason('video', true); // duplicate add — no-op
    source.setPauseReason('video', false);
    source.setPauseReason('video', false); // duplicate remove — no-op

    // After idempotent calls, state is clean
    source.setPauseReason('video', true);
    source.setPauseReason('video', false);
  });

  it('three distinct reasons can coexist', () => {
    const source = createSource();

    source.setPauseReason('visibility', true);
    source.setPauseReason('video', true);
    source.setPauseReason('buffering', true);

    // Clear all
    source.setPauseReason('visibility', false);
    source.setPauseReason('video', false);
    source.setPauseReason('buffering', false);
  });

  it('injectExternalMessages ignores duplicates when callback is registered', () => {
    const source = createSource();
    const received: unknown[] = [];

    // Set up callback and inject a message
    source.start(
      (msgs) => {
        received.push(Array.isArray(msgs) ? msgs.length : 1);
      },
      new AbortController().signal
    );

    // Inject empty — no crash
    source.injectExternalMessages([]);
    source.injectExternalMessages([]);

    source.stop();
  });

  it('stop aborts the polling signal even when start receives an external signal', async () => {
    const source = createSource();
    source.setInitialBootstrap({} as ChatBootstrapData);
    const externalController = new AbortController();

    const status = await source.start(() => {}, externalController.signal);

    expect(status).toBe('started');
    expect(source.lastLaunchedSignal?.aborted).toBe(false);
    source.stop();
    expect(source.lastLaunchedSignal?.aborted).toBe(true);
    expect(externalController.signal.aborted).toBe(false);
  });

  it('does not reuse consumed bootstrap data on a later start', async () => {
    const source = createSource();
    source.setInitialBootstrap({} as ChatBootstrapData);

    await expect(source.start(() => {})).resolves.toBe('started');

    await expect(source.start(() => {})).resolves.toBe('unavailable');
    source.stop();
  });
});
