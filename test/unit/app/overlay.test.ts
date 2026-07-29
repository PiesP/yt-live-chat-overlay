// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Overlay } from '@app/overlay';
import type { OverlaySettings } from '@app-types';

function makeSettings(overrides: Partial<OverlaySettings> = {}): OverlaySettings {
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

describe('Overlay', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('constructs without throwing', () => {
    expect(() => new Overlay()).not.toThrow();
  });

  it('getDimensions returns null before create', () => {
    const overlay = new Overlay();
    expect(overlay.getDimensions()).toBeNull();
  });

  it('getContainer returns null before create', () => {
    const overlay = new Overlay();
    expect(overlay.getContainer()).toBeNull();
  });

  it('updateSettings does not throw before overlay is created', () => {
    const overlay = new Overlay();
    expect(() => overlay.updateSettings(makeSettings())).not.toThrow();
  });

  it('toggles user pause state and notifies callbacks', () => {
    const overlay = new Overlay();
    const cb = vi.fn();
    const unsub = overlay.onUserPauseChanged(cb);

    const result = overlay.toggleUserPause();
    expect(result).toBe(true);
    expect(cb).toHaveBeenCalledWith(true);

    overlay.toggleUserPause();
    expect(cb).toHaveBeenCalledWith(false);

    unsub();
    overlay.toggleUserPause();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('onDimensionsChanged returns unsubscribe function that works', () => {
    const overlay = new Overlay();
    const cb = vi.fn();
    const unsub = overlay.onDimensionsChanged(cb);
    expect(typeof unsub).toBe('function');
    unsub(); // Should not throw
  });

  it('updateLiveRegion does not throw when liveRegion is null', () => {
    const overlay = new Overlay();
    expect(() =>
      overlay.updateLiveRegion([{ id: '1', text: 'test message', kind: 'text' }])
    ).not.toThrow();
  });

  it('preserves repeated full messages with distinct IDs and announces paid context', async () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    Object.defineProperties(player, {
      offsetWidth: { configurable: true, value: 1280 },
      offsetHeight: { configurable: true, value: 720 },
    });
    player.getBoundingClientRect = () =>
      ({ width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }) as DOMRect;
    document.body.appendChild(player);

    const overlay = new Overlay();
    await expect(overlay.create(makeSettings())).resolves.toBe(true);
    vi.useFakeTimers();
    const repeatedText =
      'A full repeated message that must not be truncated at eighty characters '.repeat(2);
    overlay.updateLiveRegion([
      { id: 'one', text: repeatedText, kind: 'text', author: 'First author' },
      {
        id: 'two',
        text: repeatedText,
        kind: 'superchat',
        author: 'Second author',
        superChatAmount: '$5.00',
      },
    ]);
    vi.advanceTimersByTime(500);

    const announcements = Array.from(
      document.querySelectorAll<HTMLParagraphElement>('.yt-live-chat-overlay-live-region p')
    );
    expect(announcements).toHaveLength(2);
    expect(announcements[0]?.textContent).toContain(`First author — ${repeatedText}`);
    expect(announcements[1]?.textContent).toContain(
      `Super Chat — $5.00 — Second author — ${repeatedText}`
    );
    expect(announcements[1]?.dataset.messageId).toBe('two');

    overlay.destroy();
  });

  it('updateLanguage does not throw when container is null', () => {
    const overlay = new Overlay();
    expect(() => overlay.updateLanguage()).not.toThrow();
  });

  it('destroy before create does not throw', () => {
    const overlay = new Overlay();
    expect(() => overlay.destroy()).not.toThrow();
  });

  it('create returns false when no player element found', async () => {
    const overlay = new Overlay();
    // jsdom has no YouTube player element, so findPlayerContainer returns null
    const created = await overlay.create(makeSettings());
    expect(created).toBe(false);
    overlay.destroy();
  });

  it('double destroy is safe', () => {
    const overlay = new Overlay();
    overlay.destroy();
    expect(() => overlay.destroy()).not.toThrow();
    expect(overlay.getContainer()).toBeNull();
    expect(overlay.getDimensions()).toBeNull();
  });

  it('toggleUserPause cycles true/false', () => {
    const overlay = new Overlay();
    expect(overlay.toggleUserPause()).toBe(true);
    expect(overlay.toggleUserPause()).toBe(false);
    expect(overlay.toggleUserPause()).toBe(true);
  });

  it('onUserPauseChanged supports multiple subscribers', () => {
    const overlay = new Overlay();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    overlay.onUserPauseChanged(cb1);
    overlay.onUserPauseChanged(cb2);

    overlay.toggleUserPause();
    expect(cb1).toHaveBeenCalledWith(true);
    expect(cb2).toHaveBeenCalledWith(true);
  });
});
