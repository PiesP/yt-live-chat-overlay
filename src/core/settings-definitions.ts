import type {
  AuthorDisplaySettings,
  ColorSettings,
  OutlineSettings,
  OverlaySettings,
} from '@app-types';
import { isLogLevel } from '@app-types';
import { colors as designColors } from '@core/design-tokens';

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
  | 'minTextLength'
  | 'outlineWidthPx'
  | 'outlineBlurPx'
  | 'outlineOpacity'
  | 'laneSpacing'
  | 'authorRateLimitWindowMs'
  | 'authorRateLimitMaxMessages'
  | 'backlogMaxRate'
  | 'backlogSpeedMultiplier'
  | 'backlogRecentMinutes';

const DEFAULT_SHOW_AUTHOR: AuthorDisplaySettings = {
  normal: false,
  member: false,
  moderator: true,
  owner: true,
  verified: false,
  superChat: true,
};

const DEFAULT_COLORS: ColorSettings = {
  normal: designColors.authorNormal,
  member: designColors.authorMember,
  moderator: designColors.authorModerator,
  owner: designColors.authorOwner,
  verified: designColors.authorVerified,
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
  minTextLength: { min: 1, max: 10, step: 1 },
  outlineWidthPx: { min: 0, max: 5, step: 0.5 },
  outlineBlurPx: { min: 0, max: 8, step: 0.5 },
  outlineOpacity: { min: 0, max: 1, step: 0.1 },
  laneSpacing: { min: 0, max: 20, step: 1 },
  authorRateLimitWindowMs: { min: 1000, max: 30000, step: 1000 },
  authorRateLimitMaxMessages: { min: 1, max: 20, step: 1 },
  backlogMaxRate: { min: 0, max: 50, step: 5 },
  backlogSpeedMultiplier: { min: 1, max: 5, step: 0.5 },
  backlogRecentMinutes: { min: 1, max: 30, step: 1 },
} as const satisfies Record<SettingsLimitKey, NumericSettingLimit>;

export const DEFAULT_SETTINGS = {
  enabled: true,
  speedPxPerSec: 250,
  fontSize: 20,
  opacity: 0.85,
  superChatOpacity: 0.35,
  safeTop: 0,
  safeBottom: 0.15,
  maxConcurrentMessages: 50,
  allowShortTextMessages: false,
  minTextLength: 3,
  logLevel: 'warn',
  showAuthor: DEFAULT_SHOW_AUTHOR,
  colors: DEFAULT_COLORS,
  outline: DEFAULT_OUTLINE,
  laneSpacing: 0,
  showDebugOverlay: false,
  authorRateLimitEnabled: true,
  authorRateLimitWindowMs: 5000,
  authorRateLimitMaxMessages: 5,
  backlogMaxRate: 10,
  backlogSpeedMultiplier: 2,
  showBacklogIndicator: true,
  backlogMode: 'playback',
  backlogRecentMinutes: 5,
} as const satisfies Readonly<OverlaySettings>;

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

/**
 * Read and parse the raw stored settings blob from localStorage.
 * Returns the parsed object or null on failure.
 */
export function readStoredSettingsRaw(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      '__proto__' in parsed ||
      'constructor' in parsed
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const readStoredLogLevel = (): OverlaySettings['logLevel'] => {
  const parsed = readStoredSettingsRaw();
  if (!parsed) return DEFAULT_SETTINGS.logLevel;
  if (isLogLevel(parsed.logLevel)) {
    return parsed.logLevel;
  }

  return DEFAULT_SETTINGS.logLevel;
};
