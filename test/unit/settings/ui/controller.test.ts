// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import type { OverlaySettings } from '@app-types';
import { resolveActiveLanguage } from '@i18n/index';
import { DEFAULT_SETTINGS } from '@settings/defaults';
import { MAX_SETTINGS_IMPORT_BYTES, SettingsUi } from '@settings/ui/controller';
import { SETTINGS_UI_DESIGN } from '@settings/ui/design-adapter';
import { STYLE_ID } from '@settings/ui/form';
import { SETTINGS_UI_STYLES } from '@settings/ui/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock findPlayerContainerElement so it returns our player element
vi.mock('@util/dom', async () => {
  const actual = (await vi.importActual('@util/dom')) as Record<string, unknown>;
  return {
    ...actual,
    findPlayerContainerElement: vi.fn(),
  };
});

import { findPlayerContainerElement as mockFinder } from '@util/dom';

function makeDefaults(overrides: Partial<OverlaySettings> = {}): OverlaySettings {
  return {
    enabled: true,
    danmakuMode: 'scroll' as const,
    speedPxPerSec: 250,
    fontSize: 32,
    opacity: 1,
    superChatOpacity: 0.95,
    safeTop: 0,
    safeBottom: 0,
    maxConcurrentMessages: 300,
    allowShortTextMessages: false,
    minTextLength: 1,
    logLevel: 'warn' as const,
    showAuthor: {
      normal: false,
      member: true,
      moderator: true,
      owner: true,
      verified: true,
      superChat: true,
    },
    colors: {
      normal: '#FFFFFF',
      member: '#0F9D58',
      moderator: '#5E84F1',
      owner: '#FFD600',
      verified: '#AAAAAA',
    },
    outline: { enabled: true, widthPx: 2, opacity: 0.7 },
    laneSpacing: 1,
    showDebugOverlay: false,
    ignoreReducedMotion: false,
    authorRateLimit: 'normal' as const,
    backlogMaxRate: 10,
    backlogSpeedMultiplier: 1,
    backlogMode: 'playback' as const,
    backlogRecentMinutes: 5,
    backlogOpacityMultiplier: 0.5,
    depthLayersEnabled: false,
    depthNearSpeedMul: 1.2,
    depthFarSpeedMul: 0.8,
    depthFarOpacityMul: 0.6,
    modOwnerDurationMultiplier: 1.5,
    showSuperChatAmount: true,
    fontWeight: 'bold' as const,
    fontFamily: "'YouTube Sans', 'Roboto', 'Arial', sans-serif",
    preserveUserColor: true,
    superChatMaxBodyLines: 3,
    membershipMaxBodyLines: 2,
    fadeDurationMs: 300,
    minPollIntervalMs: 1000,
    maxPollIntervalMs: 10000,
    language: 'en' as const,
    translationEnabled: false,
    translationService: 'auto' as const,
    translationSource: 'auto' as const,
    translationTarget: 'en' as const,
    translationMode: 'dual' as const,
    exitPaddingPx: 50,
    scrollDurationMinMs: 3000,
    scrollDurationMaxMs: 15000,
    topBottomDurationMs: 5000,
    queueMaxSize: 500,
    backgroundQueueMax: 200,
    maxMessageAgeMs: 30000,
    headwayGapRatio: 0.3,
    emojiCacheMb: 20,
    photoCacheMb: 10,
    stickerCacheMb: 5,
    textCacheMb: 5,
    translationBatchSize: 5,
    emojiFetchLimit: 20,
    failedEmojiRetryMins: 5,
    burstSampleWindow: 60,
    burstElevatedThreshold: 5,
    burstHighThreshold: 15,
    burstExtremeThreshold: 30,
    backlogInjectionMax: 50,
    backlogDensityRampMs: 5000,
    livePollFallbackMs: 2000,
    livePollFailureLimit: 5,
    speedBoostThreshold: 2,
    backlogPauseThreshold: 0.3,
    backlogResumeThreshold: 0.1,
    activityTimeoutMs: 60000,
    staggerMaxDelayMs: 100,
    staggerMediumDelayMs: 50,
    emojiFetchTimeoutMs: 5000,
    backlogDensityRampMaxMs: 10000,
    backlogInjectionRateMin: 1,
    speedBoostMax: 1,
    speedBoostDenom: 2,
    backlogToggleCooldownMs: 2000,
    replayPrefetchPages: 50,
    replayBatchLimit: 50,
    ...overrides,
  } as OverlaySettings;
}

describe('SettingsUi', () => {
  beforeEach(() => {
    // jsdom doesn't implement HTMLDialogElement.close() / showModal()
    // Patch the prototype so SettingsUi can create functional dialogs
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(
      (tag: string, _options?: ElementCreationOptions) => {
        const el = origCreateElement(tag);
        if (tag === 'dialog') {
          (el as any).close = vi.fn();
          (el as any).showModal = vi.fn();
          (el as any).show = vi.fn();
          // 'open' property for dialog state
          Object.defineProperty(el, 'open', { value: false, writable: true, configurable: true });
        }
        return el;
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    resolveActiveLanguage('en');
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
      overrides?.onReload
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

  it('destroy disconnects the mounted preview observer and cancels its pending frame', async () => {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(target: Element): void {
          observed.push(target);
        }
        unobserve(): void {}
        disconnect = disconnect;
      }
    );
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(73);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    const controller = makeController();

    try {
      await controller.attach();
      const preview = document.querySelector('.yt-chat-overlay-settings-font-preview-stage');
      expect(preview).not.toBeNull();
      expect(observed).toContain(preview);
      controller.destroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(cancelFrame).toHaveBeenCalledWith(73);
      expect(preview?.isConnected).toBe(false);
      controller.destroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      controller.destroy();
      vi.unstubAllGlobals();
    }
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

    const style = document.getElementById(STYLE_ID);
    expect(style?.tagName).toBe('STYLE');
    expect(style?.textContent).toBe(SETTINGS_UI_STYLES);
    expect(style?.textContent).toContain(SETTINGS_UI_DESIGN.colors.accent);

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
    const c = new SettingsUi(() => makeDefaults(), vi.fn(), vi.fn(), undefined, onReload);
    await c.attach();

    const reloadBtn = document.getElementById('yt-chat-overlay-reload-button');
    expect(reloadBtn).not.toBeNull();

    c.destroy();
  });

  it('keeps reload feedback neutral while pending and bounds repeated activation', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    let resolveReload: () => void = () => {};
    const onReload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReload = resolve;
        })
    );
    const controller = makeController({ onReload });
    await controller.attach();
    const settingsButton = player.querySelector<HTMLButtonElement>(
      '#yt-chat-overlay-settings-button'
    );
    const button = player.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
    const feedback = player.querySelector<HTMLElement>('.yt-chat-overlay-reload-feedback');
    expect(button).not.toBeNull();
    expect(settingsButton?.getAttribute('title')).toBe('Chat overlay settings');
    expect(button?.getAttribute('title')).toBe('Reload overlay');
    button?.click();
    button?.click();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(button?.textContent).toBe('…');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(feedback?.textContent).toBe('Restarting overlay…');
    expect(settingsButton?.getAttribute('title')).toBeNull();
    expect(button?.getAttribute('title')).toBeNull();
    expect(button?.classList.contains('yt-chat-overlay-reload-button--done')).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(feedback?.textContent).toContain('Still restarting');
    resolveReload();
    await Promise.resolve();
    expect(button?.textContent).toBe('↻');
    expect(button?.hasAttribute('aria-busy')).toBe(false);
    expect(feedback?.textContent).toContain('attempt ended');
    expect(button?.getAttribute('title')).toBeNull();
    vi.advanceTimersByTime(2500);
    expect(feedback?.hidden).toBe(true);
    expect(settingsButton?.getAttribute('title')).toBe('Chat overlay settings');
    expect(button?.getAttribute('title')).toBe('Reload overlay');
    controller.destroy();
  });

  it('shows automatic recovery outside the overlay and gives manual reload precedence', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    let resolveReload: () => void = () => {};
    const controller = makeController({
      onReload: () =>
        new Promise<void>((resolve) => {
          resolveReload = resolve;
        }),
    });
    await controller.attach();
    const settingsButton = player.querySelector<HTMLButtonElement>(
      '#yt-chat-overlay-settings-button'
    );
    const button = player.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
    const feedback = player.querySelector<HTMLElement>('.yt-chat-overlay-reload-feedback');

    controller.showRuntimeRecoveryStatus('recovering');
    expect(feedback?.dataset.phase).toBe('recovering');
    expect(feedback?.hidden).toBe(false);
    expect(feedback?.textContent).toContain('Recovering overlay');
    expect(settingsButton?.getAttribute('title')).toBeNull();
    expect(button?.getAttribute('aria-busy')).toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Reload overlay');
    expect(button?.textContent).toBe('↻');

    button?.click();
    controller.showRuntimeRecoveryStatus('failed');
    expect(feedback?.dataset.phase).toBe('pending');
    resolveReload();
    await Promise.resolve();
    expect(feedback?.dataset.phase).toBe('requested');
    vi.advanceTimersByTime(2500);
    expect(feedback?.dataset.phase).toBe('failed');
    controller.showRuntimeRecoveryStatus(null);
    expect(feedback?.dataset.phase).toBe('idle');
    expect(feedback?.hidden).toBe(true);
    expect(settingsButton?.getAttribute('title')).toBe('Chat overlay settings');
    controller.destroy();
  });

  it('closes open native tooltips during recovery and restores their anchors on idle', async () => {
    const hints = SettingsUi as unknown as { supportsHints: boolean };
    const original = hints.supportsHints;
    hints.supportsHints = true;
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    const controller = makeController({ onReload: vi.fn().mockResolvedValue(undefined) });
    try {
      await controller.attach();
      const settingsButton = player.querySelector<HTMLButtonElement>(
        '#yt-chat-overlay-settings-button'
      );
      const reloadButton = player.querySelector<HTMLButtonElement>(
        '#yt-chat-overlay-reload-button'
      );
      const settingsTooltip = player.querySelector<HTMLElement>(
        '#yt-chat-overlay-settings-tooltip'
      );
      const reloadTooltip = player.querySelector<HTMLElement>('#yt-chat-overlay-reload-tooltip');
      expect(settingsButton?.getAttribute('interestfor')).toBe('yt-chat-overlay-settings-tooltip');
      expect(reloadButton?.getAttribute('interestfor')).toBe('yt-chat-overlay-reload-tooltip');
      const hideSettings = vi.fn();
      const hideReload = vi.fn();
      if (settingsTooltip) {
        vi.spyOn(settingsTooltip, 'matches').mockReturnValue(true);
        settingsTooltip.hidePopover = hideSettings;
      }
      if (reloadTooltip) {
        vi.spyOn(reloadTooltip, 'matches').mockReturnValue(true);
        reloadTooltip.hidePopover = hideReload;
      }

      settingsButton?.focus();
      controller.showRuntimeRecoveryStatus('recovering');
      expect(document.activeElement).toBe(settingsButton);
      expect(settingsButton?.getAttribute('aria-label')).toBe('Chat overlay settings');
      expect(settingsButton?.getAttribute('interestfor')).toBeNull();
      expect(reloadButton?.getAttribute('interestfor')).toBeNull();
      expect(hideSettings).toHaveBeenCalledOnce();
      expect(hideReload).toHaveBeenCalledOnce();

      controller.showRuntimeRecoveryStatus(null);
      expect(settingsButton?.getAttribute('interestfor')).toBe('yt-chat-overlay-settings-tooltip');
      expect(reloadButton?.getAttribute('interestfor')).toBe('yt-chat-overlay-reload-tooltip');
      controller.showPersistenceState('unsaved');
      expect(settingsButton?.getAttribute('interestfor')).toBeNull();
      expect(reloadButton?.getAttribute('interestfor')).toBeNull();
      expect(hideSettings).toHaveBeenCalledTimes(2);
      expect(hideReload).toHaveBeenCalledTimes(2);
      controller.showPersistenceState('pending');
      expect(settingsButton?.getAttribute('interestfor')).toBe('yt-chat-overlay-settings-tooltip');
      expect(reloadButton?.getAttribute('interestfor')).toBe('yt-chat-overlay-reload-tooltip');
    } finally {
      controller.destroy();
      hints.supportsHints = original;
    }
  });

  it('shows a retryable reload failure and ignores completion after destroy', async () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    let resolveReload: () => void = () => {};
    const onReload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('controlled failure'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveReload = resolve;
          })
      );
    const controller = makeController({ onReload });
    await controller.attach();
    const button = player.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
    const feedback = player.querySelector<HTMLElement>('.yt-chat-overlay-reload-feedback');
    button?.click();
    await Promise.resolve();
    expect(button?.textContent).toBe('!');
    expect(feedback?.textContent).toContain('Could not restart');
    expect(button?.getAttribute('aria-label')).toContain('Try reloading');
    expect(button?.getAttribute('title')).toBeNull();
    button?.click();
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(button?.textContent).toBe('…');
    controller.destroy();
    resolveReload();
    await Promise.resolve();
    expect(player.querySelector('.yt-chat-overlay-reload-feedback')).toBeNull();
  });

  it('keeps denied-save feedback outside the closed dialog and allows one manual retry', async () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    let state: 'unsaved' | 'saved' = 'unsaved';
    const retry = vi.fn(async () => {
      state = 'saved' as const;
      return state;
    });
    const controller = new SettingsUi(
      () => makeDefaults(),
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      { state: () => state, retry, resolveConflict: vi.fn(async () => state) }
    );
    await controller.attach();
    const notice = player.querySelector('.yt-chat-overlay-settings-persistence-notice');
    expect(notice?.textContent).toContain('were not saved');
    const button = notice?.querySelector('button');
    expect(button?.textContent).toBe('Retry save');
    button?.click();
    controller.showPersistenceState('pending');
    await vi.waitFor(() => expect(player.textContent).toContain('Settings saved.'));
    expect(retry).toHaveBeenCalledTimes(1);
    controller.destroy();
    expect(player.querySelector('.yt-chat-overlay-settings-persistence-notice')).toBeNull();
  });

  it('suppresses the Settings title while a persistence notice exists without Reload', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    const controller = makeController();
    await controller.attach();
    const button = player.querySelector<HTMLButtonElement>('#yt-chat-overlay-settings-button');
    expect(button?.title).toBe('Chat overlay settings');
    controller.showPersistenceState('unsaved');
    expect(button?.getAttribute('title')).toBeNull();
    controller.showPersistenceState('conflict');
    expect(button?.getAttribute('title')).toBeNull();
    controller.showPersistenceState('saved');
    expect(button?.getAttribute('title')).toBeNull();
    vi.advanceTimersByTime(2500);
    expect(player.querySelector('.yt-chat-overlay-settings-persistence-notice')).toBeNull();
    expect(button?.title).toBe('Chat overlay settings');
    controller.destroy();
  });

  it('keeps the Settings tooltip suppressed until recovery and persistence both end', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    const controller = makeController({ onReload: vi.fn().mockResolvedValue(undefined) });
    await controller.attach();
    const button = player.querySelector<HTMLButtonElement>('#yt-chat-overlay-settings-button');
    const reload = player.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
    controller.showPersistenceState('unsaved');
    expect(button?.getAttribute('title')).toBeNull();
    expect(reload?.getAttribute('title')).toBeNull();
    controller.showRuntimeRecoveryStatus('recovering');
    controller.showPersistenceState('saved');
    vi.advanceTimersByTime(2500);
    expect(button?.getAttribute('title')).toBeNull();
    expect(reload?.getAttribute('title')).toBeNull();
    controller.showRuntimeRecoveryStatus(null);
    expect(button?.title).toBe('Chat overlay settings');
    expect(reload?.title).toBe('Reload overlay');
    controller.destroy();
  });

  it('persists once when the native close event arrives after a programmatic close', async () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    const onPersist = vi.fn(async () => 'saved' as const);
    const controller = new SettingsUi(() => makeDefaults(), vi.fn(), vi.fn(), onPersist);
    await controller.attach();
    const modal = document.querySelector<HTMLDialogElement>('#yt-chat-overlay-settings-backdrop');
    expect(modal).not.toBeNull();
    modal!.close = vi.fn(() => {
      modal!.open = false;
      queueMicrotask(() => modal!.dispatchEvent(new Event('close')));
    });
    modal!.open = true;
    controller.close();
    await vi.waitFor(() => expect(modal!.close).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onPersist).toHaveBeenCalledTimes(1);

    // A later native backdrop dismissal still persists its own form once.
    modal!.open = true;
    modal!.open = false;
    modal!.dispatchEvent(new Event('close'));
    expect(onPersist).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it('keeps a remote conflict after ordinary dialog close until Save my values is chosen', async () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.appendChild(player);
    vi.mocked(mockFinder).mockResolvedValue(player);
    let state: 'conflict' | 'saved' = 'conflict';
    const onPersist = vi.fn(async () => state);
    const resolveConflict = vi.fn(async () => {
      state = 'saved' as const;
      return state;
    });
    const controller = new SettingsUi(
      () => DEFAULT_SETTINGS,
      vi.fn(),
      vi.fn(),
      onPersist,
      undefined,
      { state: () => state, retry: vi.fn(async () => state), resolveConflict }
    );
    await controller.attach();
    document.querySelector<HTMLButtonElement>('#yt-chat-overlay-settings-button')?.click();
    const modal = document.querySelector<HTMLDialogElement>('#yt-chat-overlay-settings-backdrop');
    if (modal) modal.open = true;
    controller.close();
    await vi.waitFor(() => expect(onPersist).toHaveBeenCalledTimes(1));
    expect(resolveConflict).not.toHaveBeenCalled();
    const notice = player.querySelector('.yt-chat-overlay-settings-persistence-notice');
    expect(notice?.textContent).toContain('Another tab changed settings');
    const button = notice?.querySelector('button');
    expect(button?.textContent).toBe('Save my values');
    button?.click();
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    if (modal) modal.open = false;
    controller.destroy();
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

  it('uses the real lookup without attaching UI from an obsolete attach', async () => {
    vi.useFakeTimers();
    const actualDom = await vi.importActual<typeof import('@util/dom')>('@util/dom');
    vi.mocked(mockFinder).mockImplementation(actualDom.findPlayerContainerElement);
    let width = 0;
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    Object.defineProperties(playerEl, {
      offsetWidth: { get: () => width },
      offsetHeight: { value: 100 },
    });
    document.body.append(playerEl);
    const controller = makeController();
    const first = controller.attach();
    const firstAbort = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    const second = controller.attach();
    await firstAbort;
    width = 100;
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(playerEl.querySelectorAll('#yt-chat-overlay-settings-button')).toHaveLength(1);
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('localizes the reset confirmation as one coherent Korean dialog', async () => {
    resolveActiveLanguage('ko');
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    document.body.appendChild(playerEl);
    vi.mocked(mockFinder).mockResolvedValue(playerEl);

    const c = makeController();
    await c.attach();
    document
      .querySelector<HTMLButtonElement>(
        '#yt-chat-overlay-settings-backdrop button[data-action="reset"]'
      )
      ?.click();

    const confirmation = document.querySelector('dialog.yt-chat-overlay-settings-confirm');
    expect(confirmation?.querySelector('#yt-chat-overlay-confirm-msg')?.textContent).toBe(
      '모든 설정을 기본값으로 초기화할까요?'
    );
    expect(
      Array.from(confirmation?.querySelectorAll('button') ?? [], (button) => button.textContent)
    ).toEqual(['취소', '초기화']);
    c.destroy();
  });

  it('rejects an oversized settings import before constructing a FileReader', async () => {
    const playerEl = document.createElement('div');
    playerEl.id = 'movie_player';
    document.body.appendChild(playerEl);
    vi.mocked(mockFinder).mockResolvedValue(playerEl);
    const FileReaderMock = vi.fn();
    vi.stubGlobal('FileReader', FileReaderMock);

    const c = makeController();
    await c.attach();
    document
      .querySelector<HTMLButtonElement>(
        '#yt-chat-overlay-settings-backdrop button[data-action="import"]'
      )
      ?.click();

    const createElementMock = vi.mocked(document.createElement);
    const inputResult = createElementMock.mock.results.findLast(
      (_result, index) => createElementMock.mock.calls[index]?.[0] === 'input'
    );
    const input = inputResult?.value as HTMLInputElement | undefined;
    expect(input).toBeInstanceOf(HTMLInputElement);
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ size: MAX_SETTINGS_IMPORT_BYTES + 1 }],
    });
    input?.dispatchEvent(new Event('change'));

    expect(FileReaderMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Import failed: settings file is too large');
    const toast = document.querySelector('.yt-chat-overlay-settings-toast');
    const footer = document.querySelector('.yt-chat-overlay-settings-actions-wrapper');
    expect(toast?.parentElement).toBe(footer);
    expect(footer?.firstElementChild).toBe(toast);
    c.destroy();
  });
});
