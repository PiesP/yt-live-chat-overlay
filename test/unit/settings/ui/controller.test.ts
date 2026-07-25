// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsUi } from '@settings/ui/controller';
import type { OverlaySettings } from '@app-types';

// Mock findPlayerContainerElement so it returns our player element
vi.mock('@util/dom', async () => {
  const actual = await vi.importActual('@util/dom') as Record<string, unknown>;
  return {
    ...actual,
    findPlayerContainerElement: vi.fn(),
  };
});

import { findPlayerContainerElement as mockFinder } from '@util/dom';

function makeDefaults(overrides: Partial<OverlaySettings> = {}): OverlaySettings {
  return {
    enabled: true, danmakuMode: 'scroll' as const, speedPxPerSec: 250,
    fontSize: 32, opacity: 1, superChatOpacity: 0.95, safeTop: 0, safeBottom: 0,
    maxConcurrentMessages: 300, allowShortTextMessages: false, minTextLength: 1,
    logLevel: 'warn' as const,
    showAuthor: { normal: false, member: true, moderator: true, owner: true, verified: true, superChat: true },
    colors: { normal: '#FFFFFF', member: '#0F9D58', moderator: '#5E84F1', owner: '#FFD600', verified: '#AAAAAA' },
    outline: { enabled: true, widthPx: 2, opacity: 0.7 },
    laneSpacing: 1, showDebugOverlay: false, ignoreReducedMotion: false,
    authorRateLimit: 'normal' as const, backlogMaxRate: 10, backlogSpeedMultiplier: 1,
    backlogMode: 'playback' as const, backlogRecentMinutes: 5, backlogOpacityMultiplier: 0.5,
    depthLayersEnabled: false, depthNearSpeedMul: 1.2, depthFarSpeedMul: 0.8, depthFarOpacityMul: 0.6,
    modOwnerDurationMultiplier: 1.5, showSuperChatAmount: true,
    fontWeight: 'bold' as const, fontFamily: "'YouTube Sans', 'Roboto', 'Arial', sans-serif",
    preserveUserColor: true, superChatMaxBodyLines: 3, membershipMaxBodyLines: 2,
    fadeDurationMs: 300, minPollIntervalMs: 1000, maxPollIntervalMs: 10000,
    language: 'en' as const, translationEnabled: false, translationService: 'auto' as const,
    translationSource: 'auto' as const, translationTarget: 'en' as const,
    translationMode: 'dual' as const, exitPaddingPx: 50,
    scrollDurationMinMs: 3000, scrollDurationMaxMs: 15000, topBottomDurationMs: 5000,
    queueMaxSize: 500, backgroundQueueMax: 200, maxMessageAgeMs: 30000, headwayGapRatio: 0.3,
    emojiCacheMb: 20, photoCacheMb: 10, stickerCacheMb: 5, textCacheMb: 5,
    translationBatchSize: 5, emojiFetchLimit: 20, failedEmojiRetryMins: 5,
    burstSampleWindow: 60, burstElevatedThreshold: 5, burstHighThreshold: 15, burstExtremeThreshold: 30,
    backlogInjectionMax: 50, backlogDensityRampMs: 5000, livePollFallbackMs: 2000, livePollFailureLimit: 5,
    speedBoostThreshold: 2, backlogPauseThreshold: 0.3, backlogResumeThreshold: 0.1,
    activityTimeoutMs: 60000, staggerMaxDelayMs: 100, staggerMediumDelayMs: 50,
    emojiFetchTimeoutMs: 5000, backlogDensityRampMaxMs: 10000, backlogInjectionRateMin: 1,
    speedBoostMax: 1, speedBoostDenom: 2, backlogToggleCooldownMs: 2000,
    replayPrefetchPages: 50, replayBatchLimit: 50,
    ...overrides,
  } as OverlaySettings;
}

describe('SettingsUi', () => {
  beforeEach(() => {
    // jsdom doesn't implement HTMLDialogElement.close() / showModal()
    // Patch the prototype so SettingsUi can create functional dialogs
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, _options?: ElementCreationOptions) => {
      const el = origCreateElement(tag);
      if (tag === 'dialog') {
        (el as any).close = vi.fn();
        (el as any).showModal = vi.fn();
        (el as any).show = vi.fn();
        // 'open' property for dialog state
        Object.defineProperty(el, 'open', { value: false, writable: true, configurable: true });
      }
      return el;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function makeController(overrides?: {
    getSettings?: () => Readonly<OverlaySettings>;
    onChange?: (partial: Partial<OverlaySettings>) => void;
    resetSettings?: () => void;
    onPersist?: (partial: Partial<OverlaySettings>) => void;
    onReload?: () => Promise<void>;
  }) {
    return new SettingsUi(
      overrides?.getSettings ?? (() => makeDefaults()),
      overrides?.onChange ?? vi.fn(),
      overrides?.resetSettings ?? vi.fn(),
      overrides?.onPersist,
      overrides?.onReload,
    );
  }

  it('constructs without throwing', () => {
    expect(() => makeController()).not.toThrow();
  });

  it('close does not throw when never opened', () => {
    const c = makeController();
    expect(() => c.close()).not.toThrow();
  });

  it('destroy calls close and cleans up', () => {
    const c = makeController();
    expect(() => c.destroy()).not.toThrow();
    expect(() => c.destroy()).not.toThrow();
  });

  it('syncForm does not throw when dialog is not open', () => {
    const c = makeController();
    expect(() => c.syncForm()).not.toThrow();
  });

  it('syncLanguage does not throw when dialog is not open', () => {
    const c = makeController();
    expect(() => c.syncLanguage()).not.toThrow();
  });

  it('attach with mock player creates button and modal', async () => {
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    document.body.appendChild(playerEl);

    const mockedFinder = vi.mocked(mockFinder);
    mockedFinder.mockResolvedValue(playerEl);

    const c = makeController();
    await c.attach();

    const button = document.getElementById('yt-chat-overlay-settings-button');
    expect(button).not.toBeNull();

    const modal = document.getElementById('yt-chat-overlay-settings-backdrop');
    expect(modal).not.toBeNull();
    expect(modal).toBeInstanceOf(HTMLDialogElement);

    c.destroy();

    expect(document.getElementById('yt-chat-overlay-settings-button')).toBeNull();
    expect(document.getElementById('yt-chat-overlay-settings-backdrop')).toBeNull();
  });

  it('attach with mock player creates reload button when onReload provided', async () => {
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    document.body.appendChild(playerEl);

    const mockedFinder = vi.mocked(mockFinder);
    mockedFinder.mockResolvedValue(playerEl);

    const onReload = vi.fn().mockResolvedValue(undefined);
    const c = new SettingsUi(
      () => makeDefaults(),
      vi.fn(),
      vi.fn(),
      undefined,
      onReload,
    );
    await c.attach();

    const reloadBtn = document.getElementById('yt-chat-overlay-reload-button');
    expect(reloadBtn).not.toBeNull();

    c.destroy();
  });

  it('reload button not created when onReload is not provided', async () => {
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    document.body.appendChild(playerEl);

    const mockedFinder = vi.mocked(mockFinder);
    mockedFinder.mockResolvedValue(playerEl);

    const c = makeController();
    await c.attach();

    expect(document.getElementById('yt-chat-overlay-reload-button')).toBeNull();
    c.destroy();
  });

  it('attach with null player does not create UI (early return)', async () => {
    const mockedFinder = vi.mocked(mockFinder);
    mockedFinder.mockResolvedValue(null);

    const c = makeController();
    await c.attach();

    expect(document.getElementById('yt-chat-overlay-settings-button')).toBeNull();
    c.destroy();
  });

  it('second attach with same player does not duplicate UI', async () => {
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    document.body.appendChild(playerEl);

    const mockedFinder = vi.mocked(mockFinder);
    mockedFinder.mockResolvedValue(playerEl);

    const c = makeController();
    await c.attach();
    await c.attach();

    const buttons = document.querySelectorAll('#yt-chat-overlay-settings-button');
    expect(buttons.length).toBe(1);

    c.destroy();
  });
});
