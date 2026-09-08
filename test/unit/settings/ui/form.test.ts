// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsUiForm, BACKDROP_ID } from '@settings/ui/form';
import { SETTINGS_UI_STYLES } from '@settings/ui/styles';
import type { OverlaySettings } from '@app-types';

function makeDefaults(overrides: Partial<OverlaySettings> = {}): OverlaySettings {
  return {
    enabled: true, danmakuMode: 'scroll' as const, speedPxPerSec: 250,
    fontSize: 32, opacity: 1, superChatOpacity: 0.95, safeTop: 0, safeBottom: 0,
    maxConcurrentMessages: 300, allowShortTextMessages: false, minTextLength: 1,
    logLevel: 'warn' as const,
    showAuthor: { normal: false, member: true, moderator: true, owner: true, verified: true, superChat: true },
    colors: { normal: '#FFFFFF', member: '#0F9D58', moderator: '#5E84F1', owner: '#FFD600', verified: '#AAAAAA' },
    backgroundColors: { normal: '#00000000', member: '#00000000', moderator: '#1B3A6F59', owner: '#6B4F0059', verified: '#00000000' },
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

  it('renders comment fine tuning as an accessible, default-collapsed disclosure', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.append(...form.createModalContent());
    document.body.appendChild(modal);
    form.setModal(modal);
    form.populateForm(getSettings());

    const pane = modal.querySelector<HTMLElement>('#pane-comments');
    const details = pane?.querySelector<HTMLDetailsElement>(
      '.yt-chat-overlay-settings-disclosure'
    );
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Fine tuning');

    for (const name of ['enabled', 'danmakuMode', 'fontSize', 'speedPxPerSec', 'opacity']) {
      const control = pane?.querySelector<HTMLElement>(`[name="${name}"]`);
      expect(control, `${name} should remain prominent`).not.toBeNull();
      expect(control?.closest('details')).toBeNull();
    }
    for (const name of ['laneSpacing', 'safeTop', 'safeBottom', 'scrollDurationMinMs']) {
      const control = details?.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      expect(control, `${name} should remain directly editable`).not.toBeNull();
      expect(control?.type).toBe('number');
    }

    form.destroy();
    modal.remove();
  });

  it('previews accepted opacity, outline, safe-zone, and font values without raw invalid input', () => {
    const settings = makeDefaults({
      fontSize: 40,
      opacity: 0.65,
      safeTop: 0.15,
      safeBottom: 0.2,
      colors: { ...makeDefaults().colors, normal: '#101010' },
      outline: { enabled: true, widthPx: 3, opacity: 0.6 },
    });
    const form = new SettingsUiForm(() => settings, onPreview);
    const modal = document.createElement('dialog');
    modal.append(...form.createModalContent());
    document.body.appendChild(modal);
    form.setModal(modal);
    form.populateForm(settings);

    const preview = modal.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-font-preview'
    );
    const text = preview?.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-font-preview-text'
    );
    expect(preview?.getAttribute('aria-label')).toBe('Comment preview');
    expect(text?.style.fontSize).toBe('40px');
    expect(text?.style.color).toBe('rgb(16, 16, 16)');
    expect(text?.style.opacity).toBe('0.65');
    expect(text?.style.getPropertyValue('-webkit-text-stroke')).toBe(
      '2.55px rgba(255, 255, 255, 0.6)'
    );
    expect(text?.style.insetBlockStart).toBe('47.5%');
    expect(
      preview?.querySelector<HTMLElement>('[data-preview-zone="top"]')?.style.blockSize
    ).toBe('15%');
    expect(
      preview?.querySelector<HTMLElement>('[data-preview-zone="bottom"]')?.style.blockSize
    ).toBe('20%');
    expect(preview?.querySelector('[data-preview-metrics]')?.textContent).toContain(
      'Text Opacity (%): 65%'
    );
    expect(preview?.querySelector('[data-preview-metrics]')?.textContent).toContain(
      'Text Outline: 3px / 60%'
    );
    expect(preview?.querySelector('[data-preview-metrics]')?.textContent).toContain(
      'Top Clear Zone (%): 15%'
    );
    expect(preview?.querySelector('[data-preview-metrics]')?.textContent).toContain(
      'Bottom Clear Zone (%): 20%'
    );

    const fontSize = modal.querySelector<HTMLInputElement>('input[name="fontSize"]');
    expect(fontSize).not.toBeNull();
    fontSize!.value = '9999';
    fontSize!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(text?.style.fontSize).toBe('50px');
    expect(text?.style.fontSize).not.toBe('9999px');

    form.destroy();
    modal.remove();
  });

  it('keeps translation preferences visible while describing capability without claiming readiness', () => {
    const previousTranslator = globalThis.Translator;
    // @ts-expect-error Exercise the unsupported-browser UI branch.
    delete globalThis.Translator;
    try {
      const form = new SettingsUiForm(getSettings, onPreview);
      const modal = document.createElement('dialog');
      modal.append(...form.createModalContent());
      form.setModal(modal);
      form.populateForm(getSettings());

      const pane = modal.querySelector<HTMLElement>('#pane-translation');
      const preference = pane?.querySelector<HTMLInputElement>('[name="translationEnabled"]');
      expect(preference).not.toBeNull();
      const capability = pane?.querySelector('.yt-chat-overlay-settings-capability');
      expect(capability?.getAttribute('role')).toBe('status');
      expect((capability as HTMLElement | null)?.dataset.supported).toBe('false');
      expect(capability?.textContent).toBe(
        'This browser does not expose the built-in Translator API. Your preference is kept, but translation will stay inactive here.'
      );
      expect(pane?.textContent).not.toContain('ready');
      preference!.checked = true;
      expect(form.collectSettings().translationEnabled).toBe(true);

      form.destroy();
    } finally {
      globalThis.Translator = previousTranslator;
    }
  });

  it('describes an exposed translation API without claiming language-pair readiness', () => {
    const previousTranslator = globalThis.Translator;
    globalThis.Translator = {
      availability: async () => 'available' as const,
      create: async () => ({
        translate: async (text: string) => text,
        destroy: () => undefined,
      }),
    };
    try {
      const form = new SettingsUiForm(getSettings, onPreview);
      const modal = document.createElement('dialog');
      modal.append(...form.createModalContent());

      const capability = modal.querySelector<HTMLElement>(
        '#pane-translation .yt-chat-overlay-settings-capability'
      );
      expect(capability?.dataset.supported).toBe('true');
      expect(capability?.textContent).toContain('Language-pair and model availability');
      expect(capability?.textContent.toLowerCase()).not.toContain('ready');
      expect(modal.querySelector('#pane-translation [name="translationEnabled"]')).not.toBeNull();

      form.destroy();
    } finally {
      globalThis.Translator = previousTranslator;
    }
  });

  it('styles the disclosure, preview masks, metrics, and capability states inside the modal', () => {
    expect(SETTINGS_UI_STYLES).toMatch(
      /\.yt-chat-overlay-settings-disclosure\s*\{[^}]*border:/s
    );
    expect(SETTINGS_UI_STYLES).toMatch(
      /\.yt-chat-overlay-settings-disclosure\s*>\s*summary:focus-visible\s*\{[^}]*outline:/s
    );
    expect(SETTINGS_UI_STYLES).toMatch(
      /\.yt-chat-overlay-settings-font-preview-zone\s*\{[^}]*position:\s*absolute/s
    );
    expect(SETTINGS_UI_STYLES).toMatch(
      /\.yt-chat-overlay-settings-font-preview-metrics\s*\{[^}]*font-size:/s
    );
    expect(SETTINGS_UI_STYLES).toContain(
      '.yt-chat-overlay-settings-capability[data-supported="false"]'
    );
  });

  it('keeps localized tabs and actions reflowable at narrow widths', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    form.createModalContent();

    expect(SETTINGS_UI_STYLES).toContain('@media (max-width: 480px)');
    expect(SETTINGS_UI_STYLES).toMatch(
      /\.yt-chat-overlay-settings-tabs\s*\{[^}]*flex-wrap:\s*wrap/s
    );
    expect(SETTINGS_UI_STYLES).toMatch(
      /\.yt-chat-overlay-settings-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s
    );
    form.destroy();
  });

  it('uses explicit transition properties for font chips', () => {
    expect(SETTINGS_UI_STYLES).not.toMatch(
      /\.yt-chat-overlay-settings-font-chip\s*\{[^}]*transition:\s*all/s
    );
    expect(SETTINGS_UI_STYLES).toMatch(
      /\.yt-chat-overlay-settings-font-chip\s*\{[^}]*transition:[^;}]*background-color[^;}]*border-color[^;}]*color/s
    );
  });

  it('synchronizes the selected font weight for assistive technology', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);
    modal.append(...form.createModalContent());
    form.setModal(modal);
    form.populateForm(makeDefaults({ fontWeight: 'bold' }));

    const normal = modal.querySelector<HTMLButtonElement>(
      '.yt-chat-overlay-settings-weight-toggle-btn[data-value="normal"]'
    );
    const bold = modal.querySelector<HTMLButtonElement>(
      '.yt-chat-overlay-settings-weight-toggle-btn[data-value="bold"]'
    );
    expect(normal?.getAttribute('aria-pressed')).toBe('false');
    expect(bold?.getAttribute('aria-pressed')).toBe('true');

    normal?.click();
    expect(normal?.getAttribute('aria-pressed')).toBe('true');
    expect(bold?.getAttribute('aria-pressed')).toBe('false');

    form.destroy();
    modal.remove();
  });

  it('keeps clamping feedback in a stable slot until the value is corrected', () => {
    vi.useFakeTimers();
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);
    modal.append(...form.createModalContent());
    form.setModal(modal);
    form.populateForm(getSettings());

    const input = modal.querySelector<HTMLInputElement>('input[name="opacity"]');
    expect(input).not.toBeNull();
    const slot = modal.querySelector<HTMLElement>(
      '.yt-chat-overlay-settings-field-error[data-for="opacity"]'
    );
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe('');
    expect(slot?.hasAttribute('role')).toBe(false);
    expect(slot?.getAttribute('aria-live')).toBe('polite');
    expect(slot?.getAttribute('aria-atomic')).toBe('true');

    input!.value = '9999';
    form.collectSettings();
    expect(slot?.textContent).not.toBe('');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-errormessage')).toBe(slot?.id);

    vi.advanceTimersByTime(3000);
    expect(slot?.textContent).not.toBe('');

    const slider = modal.querySelector<HTMLInputElement>(
      `input[type="range"][aria-describedby="${input!.id}"]`
    );
    expect(slider).not.toBeNull();
    slider!.value = '50';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input?.value).toBe('50');
    expect(slot?.textContent).toBe('');
    expect(input?.getAttribute('aria-invalid')).toBe('false');
    expect(input?.hasAttribute('aria-errormessage')).toBe(false);

    form.destroy();
    modal.remove();
    vi.useRealTimers();
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

  it('populates and collects author background color controls', () => {
    const form = new SettingsUiForm(getSettings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);
    modal.append(...form.createModalContent());
    form.setModal(modal);
    form.populateForm(getSettings());

    const normalColor = modal.querySelector<HTMLInputElement>(
      'input[name="backgroundColor-normal"]'
    );
    const normalEnabled = modal.querySelector<HTMLInputElement>(
      'input[name="backgroundEnabled-normal"]'
    );
    const moderatorColor = modal.querySelector<HTMLInputElement>(
      'input[name="backgroundColor-moderator"]'
    );
    const moderatorEnabled = modal.querySelector<HTMLInputElement>(
      'input[name="backgroundEnabled-moderator"]'
    );

    expect(normalColor?.value).toBe('#000000');
    expect(normalEnabled?.checked).toBe(false);
    expect(normalColor?.getAttribute('aria-label')).toBe('Normal Background');
    expect(normalEnabled?.getAttribute('aria-label')).toBe('Show Normal Background');
    expect(moderatorColor?.value).toBe('#1b3a6f');
    expect(moderatorEnabled?.checked).toBe(true);

    normalColor!.value = '#112233';
    normalColor!.dispatchEvent(new Event('change'));
    expect(normalEnabled?.checked).toBe(true);
    moderatorEnabled!.checked = false;

    const collected = form.collectSettings();
    expect(collected.backgroundColors.normal).toBe('#11223359');
    expect(collected.backgroundColors.moderator).toBe('#1B3A6F00');

    form.destroy();
    modal.remove();
  });

  it('round-trips outline, author color, and visibility control groups', () => {
    const settings = makeDefaults({
      outline: { enabled: false, widthPx: 3.5, opacity: 0.4 },
      colors: { ...makeDefaults().colors, member: '#123456' },
      showAuthor: { ...makeDefaults().showAuthor, normal: true, superChat: false },
    });
    const form = new SettingsUiForm(() => settings, onPreview);
    const modal = document.createElement('dialog');
    modal.id = BACKDROP_ID;
    document.body.appendChild(modal);
    modal.append(...form.createModalContent());
    form.setModal(modal);

    form.populateForm(settings);
    const collected = form.collectSettings();

    expect(collected.outline).toEqual(settings.outline);
    expect(collected.colors.member).toBe('#123456');
    expect(collected.showAuthor.normal).toBe(true);
    expect(collected.showAuthor.superChat).toBe(false);

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
