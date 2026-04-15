/**
 * Settings Manager
 *
 * Manages user settings with localStorage persistence.
 * Only settings are stored - no chat data.
 */

import { DEFAULT_SETTINGS, isLogLevel, type OverlaySettings, SETTINGS_LIMITS } from '@app-types';

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

interface StoredSettings extends Partial<OverlaySettings> {
  debugLogging?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isColorValue = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);

const clampNumber = (
  value: unknown,
  fallback: number,
  limits: { min: number; max: number }
): number => {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(limits.max, Math.max(limits.min, numericValue));
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const normalizeRoundedNumber = (
  value: unknown,
  fallback: number,
  limits: { min: number; max: number }
): number => Math.round(clampNumber(value, fallback, limits));

const normalizeShowAuthorSettings = (
  showAuthor: Readonly<OverlaySettings['showAuthor']>
): OverlaySettings['showAuthor'] => ({
  normal: normalizeBoolean(showAuthor.normal, DEFAULT_SETTINGS.showAuthor.normal),
  member: normalizeBoolean(showAuthor.member, DEFAULT_SETTINGS.showAuthor.member),
  moderator: normalizeBoolean(showAuthor.moderator, DEFAULT_SETTINGS.showAuthor.moderator),
  owner: normalizeBoolean(showAuthor.owner, DEFAULT_SETTINGS.showAuthor.owner),
  verified: normalizeBoolean(showAuthor.verified, DEFAULT_SETTINGS.showAuthor.verified),
  superChat: normalizeBoolean(showAuthor.superChat, DEFAULT_SETTINGS.showAuthor.superChat),
});

const normalizeColorSettings = (
  colors: Readonly<OverlaySettings['colors']>
): OverlaySettings['colors'] => ({
  normal: isColorValue(colors.normal) ? colors.normal : DEFAULT_SETTINGS.colors.normal,
  member: isColorValue(colors.member) ? colors.member : DEFAULT_SETTINGS.colors.member,
  moderator: isColorValue(colors.moderator) ? colors.moderator : DEFAULT_SETTINGS.colors.moderator,
  owner: isColorValue(colors.owner) ? colors.owner : DEFAULT_SETTINGS.colors.owner,
  verified: isColorValue(colors.verified) ? colors.verified : DEFAULT_SETTINGS.colors.verified,
});

const normalizeOutlineSettings = (
  outline: Readonly<OverlaySettings['outline']>
): OverlaySettings['outline'] => ({
  enabled: normalizeBoolean(outline.enabled, DEFAULT_SETTINGS.outline.enabled),
  widthPx: clampNumber(
    outline.widthPx,
    DEFAULT_SETTINGS.outline.widthPx,
    SETTINGS_LIMITS.outlineWidthPx
  ),
  blurPx: clampNumber(
    outline.blurPx,
    DEFAULT_SETTINGS.outline.blurPx,
    SETTINGS_LIMITS.outlineBlurPx
  ),
  opacity: clampNumber(
    outline.opacity,
    DEFAULT_SETTINGS.outline.opacity,
    SETTINGS_LIMITS.outlineOpacity
  ),
});

export const cloneSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  ...settings,
  showAuthor: { ...settings.showAuthor },
  colors: { ...settings.colors },
  outline: { ...settings.outline },
});

const mergeSettings = (
  base: Readonly<OverlaySettings>,
  partial: Partial<OverlaySettings>
): OverlaySettings => ({
  ...base,
  ...partial,
  showAuthor: isRecord(partial.showAuthor)
    ? { ...base.showAuthor, ...partial.showAuthor }
    : { ...base.showAuthor },
  colors: isRecord(partial.colors) ? { ...base.colors, ...partial.colors } : { ...base.colors },
  outline: isRecord(partial.outline)
    ? { ...base.outline, ...partial.outline }
    : { ...base.outline },
});

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  enabled: normalizeBoolean(settings.enabled, DEFAULT_SETTINGS.enabled),
  speedPxPerSec: clampNumber(
    settings.speedPxPerSec,
    DEFAULT_SETTINGS.speedPxPerSec,
    SETTINGS_LIMITS.speedPxPerSec
  ),
  fontSize: clampNumber(settings.fontSize, DEFAULT_SETTINGS.fontSize, SETTINGS_LIMITS.fontSize),
  opacity: clampNumber(settings.opacity, DEFAULT_SETTINGS.opacity, SETTINGS_LIMITS.opacity),
  superChatOpacity: clampNumber(
    settings.superChatOpacity,
    DEFAULT_SETTINGS.superChatOpacity,
    SETTINGS_LIMITS.superChatOpacity
  ),
  safeTop: clampNumber(settings.safeTop, DEFAULT_SETTINGS.safeTop, SETTINGS_LIMITS.safeTop),
  safeBottom: clampNumber(
    settings.safeBottom,
    DEFAULT_SETTINGS.safeBottom,
    SETTINGS_LIMITS.safeBottom
  ),
  maxConcurrentMessages: normalizeRoundedNumber(
    settings.maxConcurrentMessages,
    DEFAULT_SETTINGS.maxConcurrentMessages,
    SETTINGS_LIMITS.maxConcurrentMessages
  ),
  maxMessagesPerSecond: normalizeRoundedNumber(
    settings.maxMessagesPerSecond,
    DEFAULT_SETTINGS.maxMessagesPerSecond,
    SETTINGS_LIMITS.maxMessagesPerSecond
  ),
  allowShortTextMessages: normalizeBoolean(
    settings.allowShortTextMessages,
    DEFAULT_SETTINGS.allowShortTextMessages
  ),
  minTextLength: normalizeRoundedNumber(
    settings.minTextLength,
    DEFAULT_SETTINGS.minTextLength,
    SETTINGS_LIMITS.minTextLength
  ),
  logLevel: isLogLevel(settings.logLevel) ? settings.logLevel : DEFAULT_SETTINGS.logLevel,
  showAuthor: normalizeShowAuthorSettings(settings.showAuthor),
  colors: normalizeColorSettings(settings.colors),
  outline: normalizeOutlineSettings(settings.outline),
  laneSpacing: normalizeRoundedNumber(
    settings.laneSpacing,
    DEFAULT_SETTINGS.laneSpacing,
    SETTINGS_LIMITS.laneSpacing
  ),
});

const normalizeStoredSettings = (stored: StoredSettings): OverlaySettings => {
  const { debugLogging, ...parsed } = stored;
  const migratedLogLevel = parsed.logLevel ?? (debugLogging ? 'debug' : undefined);

  return normalizeSettings(
    mergeSettings(DEFAULT_SETTINGS, {
      ...parsed,
      ...(migratedLogLevel ? { logLevel: migratedLogLevel } : {}),
    })
  );
};

export class Settings {
  private settings: OverlaySettings;

  constructor() {
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from localStorage
   */
  private loadSettings(): OverlaySettings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return normalizeStoredSettings(JSON.parse(stored) as StoredSettings);
      }
    } catch (error) {
      console.warn('[YT Chat Overlay] Failed to load settings:', error);
    }

    return cloneSettings(DEFAULT_SETTINGS);
  }

  /**
   * Save settings to localStorage
   */
  private saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (error) {
      console.warn('[YT Chat Overlay] Failed to save settings:', error);
    }
  }

  /**
   * Get current settings
   */
  get(): Readonly<OverlaySettings> {
    return cloneSettings(this.settings);
  }

  /**
   * Update settings
   */
  update(partial: Partial<OverlaySettings>): void {
    this.settings = normalizeSettings(mergeSettings(this.settings, partial));
    this.saveSettings();
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
    this.saveSettings();
  }
}
