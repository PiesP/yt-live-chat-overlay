// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import monkeyPlugin from 'vite-plugin-monkey';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createUserscriptConfig } from '../../../tooling/vite/configs/userscript';

vi.mock('vite-plugin-monkey', () => ({ default: vi.fn(() => []) }));

const updateUrl =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.meta.js';

async function monkeyOptions(mode: 'production' | 'development') {
  vi.mocked(monkeyPlugin).mockClear();
  const { plugins } = createUserscriptConfig({ command: 'build', mode });
  if (!Array.isArray(plugins)) {
    throw new Error('Expected userscript build plugins');
  }
  await Promise.all(plugins);
  return vi.mocked(monkeyPlugin).mock.calls[0]?.[0];
}

afterEach(() => vi.unstubAllEnvs());

describe('userscript release metadata', () => {
  it('uses the Latest download and metadata URLs for production', async () => {
    vi.stubEnv('BUILD_VERSION', '7.8.9');
    const options = await monkeyOptions('production');

    expect(options?.userscript?.downloadURL).toBe(
      'https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js'
    );
    expect(options?.userscript?.updateURL).toBe(updateUrl);
    expect(options?.userscript?.name).toBe('YouTube Live Chat Overlay');
    expect(options?.build?.metaFileName).toBe('yt-live-chat-overlay.meta.js');
  });

  it('retains the versioned download URL and no metadata file for development', async () => {
    vi.stubEnv('BUILD_VERSION', '7.8.9');
    const options = await monkeyOptions('development');

    expect(options?.userscript?.downloadURL).toBe(
      'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v7.8.9/yt-live-chat-overlay.user.js'
    );
    expect(options?.userscript?.updateURL).toBe(updateUrl);
    expect(options?.userscript?.name).toBe('YouTube Live Chat Overlay (dev)');
    expect(options?.build?.metaFileName).toBe(false);
  });

  it('keeps metadata values available without constructing the build plugin', () => {
    vi.stubEnv('VP_RESOLVING_CONFIG_METADATA', '1');
    vi.mocked(monkeyPlugin).mockClear();

    const config = createUserscriptConfig({ command: 'build', mode: 'production' });

    expect(config.plugins).toEqual([]);
    expect(config.define?.__USERSCRIPT__).toBe('true');
    expect(config.build?.minify).toBe(false);
    expect(vi.mocked(monkeyPlugin)).not.toHaveBeenCalled();
  });
});
