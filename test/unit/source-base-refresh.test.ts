// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import type { ChatBootstrapData } from '@chat/youtube/api';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshBootstrap: vi.fn(),
}));

vi.mock('@app/bootstrap-resolver', () => ({
  logBootstrapFailure: vi.fn(),
  refreshBootstrap: mocks.refreshBootstrap,
  resolveBootstrap: vi.fn(),
}));

import { ChatSource } from '@chat/source-base';

class TestChatSource extends ChatSource {
  protected seedCurrentSession(): Promise<boolean> {
    return Promise.resolve(true);
  }

  protected launchCurrentPollLoop(): void {}

  refresh(accept: (data: ChatBootstrapData) => boolean): Promise<ChatBootstrapData | null> {
    return this.refreshBootstrap(undefined, accept);
  }

  currentBootstrap(): ChatBootstrapData | null {
    return this.bootstrap;
  }
}

describe('ChatSource bootstrap refresh', () => {
  it('does not replace a valid bootstrap with a rejected refresh candidate', async () => {
    const source = new TestChatSource(() => DEFAULT_SETTINGS as OverlaySettings);
    const original = { isReplay: true } as ChatBootstrapData;
    const invalid = { isReplay: false } as ChatBootstrapData;
    source.setInitialBootstrap(original);
    mocks.refreshBootstrap.mockResolvedValue(invalid);

    await expect(source.refresh((candidate) => candidate.isReplay)).resolves.toBeNull();
    expect(source.currentBootstrap()).toBe(original);
  });
});
