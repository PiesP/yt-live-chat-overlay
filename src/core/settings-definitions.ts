import type {
  AuthorDisplaySettings,
  ColorSettings,
  OutlineSettings,
  OverlaySettings,
} from '@app-types';
import { isLogLevel } from '@app-types';

type NumericSettingLimit = Readonly<{
  min: number;
  max: number;
  step: number;
}>;

type SettingsLimitKey =
  | 'speedPxPerSec'
  | 'fontSize'
  | 'opacity'
  | 'superChatOpacity'
  | 'safeTop'
  | 'safeBottom'
  | 'maxConcurrentMessages'
  | 'maxMessagesPerSecond'
  | 'minTextLength'
  | 'outlineWidthPx'
  | 'outlineBlurPx'
  | 'outlineOpacity'
  | 'laneSpacing'
  | 'debugOverlayOpacity'
  | 'authorRateLimitWindowMs'
  | 'authorRateLimitMaxMessages'
  | 'backlogMaxRate'
  | 'backlogSpeedMultiplier';

const DEFAULT_SHOW_AUTHOR: AuthorDisplaySettings = {
  normal: false,
  member: false,
  moderator: true,
  owner: true,
  verified: false,
  superChat: true,
};

const DEFAULT_COLORS: ColorSettings = {
  normal: '#FFFFFF',
  member: '#0F9D58',
  moderator: '#5E84F1',
  owner: '#FFD600',
  verified: '#AAAAAA',
};

const DEFAULT_OUTLINE: OutlineSettings = {
  enabled: true,
  widthPx: 1.5,
  blurPx: 2,
  opacity: 0.7,
};

export const SETTINGS_LIMITS = {
  speedPxPerSec: { min: 100, max: 400, step: 10 },
  fontSize: { min: 18, max: 40, step: 2 },
  opacity: { min: 0.5, max: 1, step: 0.05 },
  superChatOpacity: { min: 0.35, max: 1, step: 0.05 },
  safeTop: { min: 0, max: 0.25, step: 0.01 },
  safeBottom: { min: 0, max: 0.5, step: 0.01 },
  maxConcurrentMessages: { min: 30, max: 100, step: 10 },
  maxMessagesPerSecond: { min: 1, max: 20, step: 1 },
  minTextLength: { min: 1, max: 10, step: 1 },
  outlineWidthPx: { min: 0, max: 5, step: 0.5 },
  outlineBlurPx: { min: 0, max: 8, step: 0.5 },
  outlineOpacity: { min: 0, max: 1, step: 0.1 },
  laneSpacing: { min: 0, max: 20, step: 1 },
  debugOverlayOpacity: { min: 0.1, max: 1, step: 0.1 },
  authorRateLimitWindowMs: { min: 1000, max: 30000, step: 1000 },
  authorRateLimitMaxMessages: { min: 1, max: 20, step: 1 },
  backlogMaxRate: { min: 0, max: 50, step: 5 },
  backlogSpeedMultiplier: { min: 1, max: 5, step: 0.5 },
} as const satisfies Record<SettingsLimitKey, NumericSettingLimit>;

export const DEFAULT_SETTINGS = {
  enabled: true,
  speedPxPerSec: 250,
  fontSize: 20,
  opacity: 0.85,
  superChatOpacity: 0.35,
  safeTop: 0,
  safeBottom: 0.4,
  maxConcurrentMessages: 50,
  maxMessagesPerSecond: 8,
  allowShortTextMessages: false,
  minTextLength: 3,
  logLevel: 'warn',
  showAuthor: DEFAULT_SHOW_AUTHOR,
  colors: DEFAULT_COLORS,
  outline: DEFAULT_OUTLINE,
  laneSpacing: 0,
  showDebugOverlay: false,
  enableDropLogging: true,
  debugOverlayOpacity: 0.8,
  authorRateLimitEnabled: true,
  authorRateLimitWindowMs: 5000,
  authorRateLimitMaxMessages: 5,
  backlogMaxRate: 10,
  backlogSpeedMultiplier: 2,
  showBacklogIndicator: true,
} as const satisfies Readonly<OverlaySettings>;

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

/**
 * Read and parse the raw stored settings blob from localStorage.
 * Exported so that settings.ts can reuse the same parse-with-try/catch logic.
 */
export function readStoredSettingsRaw<T>(): T | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const readStoredLogLevel = (): OverlaySettings['logLevel'] => {
  const parsed = readStoredSettingsRaw<{ logLevel?: unknown }>();
  if (!parsed) return DEFAULT_SETTINGS.logLevel;
  if (isLogLevel(parsed.logLevel)) {
    return parsed.logLevel;
  }

  return DEFAULT_SETTINGS.logLevel;
};
