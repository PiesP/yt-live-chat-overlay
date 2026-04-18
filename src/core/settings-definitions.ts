import type {
  AuthorDisplaySettings,
  ColorSettings,
  OutlineSettings,
  OverlaySettings,
} from '@app-types';

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
  | 'laneSpacing';

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
} as const satisfies Record<SettingsLimitKey, NumericSettingLimit>;

export const DEFAULT_SETTINGS = {
  enabled: true,
  speedPxPerSec: 280,
  fontSize: 20,
  opacity: 0.85,
  superChatOpacity: 0.35,
  safeTop: 0,
  safeBottom: 0.4,
  maxConcurrentMessages: 40,
  maxMessagesPerSecond: 6,
  allowShortTextMessages: false,
  minTextLength: 3,
  logLevel: 'warn',
  showAuthor: DEFAULT_SHOW_AUTHOR,
  colors: DEFAULT_COLORS,
  outline: DEFAULT_OUTLINE,
  laneSpacing: 0,
} as const satisfies Readonly<OverlaySettings>;
