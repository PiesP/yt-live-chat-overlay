// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsUiForm, STYLE_ID, BACKDROP_ID } from '@settings/ui/form';
import type { OverlaySettings } from '@app-types';

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

describe('SettingsUiForm', () => {
  let getSettings: () => Readonly<OverlaySettings>;
  let onPreview: () => void;

  beforeEach(() => {
    getSettings = () => makeDefaults();
    onPreview = vi.fn();
  });

  it('constructs without throwing', () => {
    expect(() => new SettingsUiForm(getSettings, onPreview)).not.toThrow();
  });

  it('createModalContent returns an array of nodes', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);

    const nodes = form.createModalContent();
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);

    form.destroy();
    modal.remove();
  });

  it('setModal with null unregisters modal', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    form.setModal(null);
    form.destroy();
  });

  it('setModal binds event listeners', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    modal.innerHTML = '<div></div>';
    document.body.appendChild(modal);

    form.setModal(modal);
    expect(() => form.setModal(null)).not.toThrow();

    form.destroy();
    modal.remove();
  });

  it('populateForm populates a created modal', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);

    // Create content and add to modal
    const nodes = form.createModalContent();
    modal.append(...nodes);
    form.setModal(modal);

    const settings = getSettings();
    form.populateForm(settings);

    // Verify some inputs are populated
    const fontSizeEl = modal.querySelector<HTMLInputElement>('input[name="fontSize"]');
    if (fontSizeEl) {
      expect(fontSizeEl.value).toBe(String(settings.fontSize));
    }

    const enabledEl = modal.querySelector<HTMLInputElement>('input[name="enabled"]');
    if (enabledEl) {
      expect(enabledEl.checked).toBe(settings.enabled);
    }

    form.destroy();
    modal.remove();
  });

  it('collectSettings returns original settings when no modal', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const collected = form.collectSettings();
    const expected = getSettings();
    expect(collected.fontSize).toBe(expected.fontSize);
    expect(collected.enabled).toBe(expected.enabled);
    form.destroy();
  });

  it('populateForm does nothing when modal is null', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    expect(() => form.populateForm(makeDefaults())).not.toThrow();
    form.destroy();
  });

  it('getFocusableElements returns empty array when no modal', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    expect(form.getFocusableElements()).toEqual([]);
    form.destroy();
  });

  it('getFocusableElements returns elements from modal', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    modal.innerHTML = '<div></div>';
    document.body.appendChild(modal);

    const nodes = form.createModalContent();
    modal.append(...nodes);
    form.setModal(modal);

    const focusable = form.getFocusableElements();
    expect(focusable.length).toBeGreaterThan(0);

    form.destroy();
    modal.remove();
  });

  it('createModalContent produces header with title', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const nodes = form.createModalContent();
    const headerEl = nodes.find((n: Node) =>
      n instanceof HTMLElement && n.classList.contains('yt-chat-overlay-settings-header')
    );
    expect(headerEl).toBeInstanceOf(HTMLElement);
    form.destroy();
  });

  it('createModalContent produces tabs', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const nodes = form.createModalContent();
    const tabsEl = nodes.find((n: Node) =>
      n instanceof HTMLElement && n.classList.contains('yt-chat-overlay-settings-tabs')
    );
    expect(tabsEl).toBeInstanceOf(HTMLElement);
    form.destroy();
  });

  it('createModalContent produces action buttons', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const nodes = form.createModalContent();
    const actionsEl = nodes.find((n: Node) =>
      n instanceof HTMLElement && n.classList.contains('yt-chat-overlay-settings-actions-wrapper')
    );
    expect(actionsEl).toBeInstanceOf(HTMLElement);
    form.destroy();
  });

  it('collectSettings from populated modal returns valid settings', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);

    const nodes = form.createModalContent();
    modal.append(...nodes);
    form.setModal(modal);
    form.populateForm(makeDefaults({ fontSize: 48, opacity: 0.8 }));

    const collected = form.collectSettings();
    expect(typeof collected.fontSize).toBe('number');
    expect(typeof collected.opacity).toBe('number');
    // fontSize should be preserved
    expect(collected.fontSize).toBe(48);

    form.destroy();
    modal.remove();
  });

  it('destroy cleans up resources', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);

    form.setModal(modal);
    form.destroy();

    // After destroy, getFocusableElements should return empty
    expect(form.getFocusableElements()).toEqual([]);
    modal.remove();
  });
});
