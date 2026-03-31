/**
 * Type definitions for YouTube Live Chat Overlay
 */

type TupleValue<T extends readonly unknown[]> = T[number];

const AUTHOR_TYPES = ['normal', 'member', 'moderator', 'owner', 'verified'] as const;
const LOG_LEVELS = ['warn', 'info', 'debug'] as const;
const AUTHOR_DISPLAY_KEYS = [...AUTHOR_TYPES, 'superChat'] as const;
const EMOJI_TYPES = ['standard', 'custom', 'member'] as const;
const CHAT_MESSAGE_KINDS = ['text', 'superchat', 'membership'] as const;
const SUPER_CHAT_TIERS = ['blue', 'cyan', 'green', 'yellow', 'orange', 'magenta', 'red'] as const;

type AuthorDisplayKey = TupleValue<typeof AUTHOR_DISPLAY_KEYS>;
type EmojiType = TupleValue<typeof EMOJI_TYPES>;
type ChatMessageKind = TupleValue<typeof CHAT_MESSAGE_KINDS>;
type SuperChatTier = TupleValue<typeof SUPER_CHAT_TIERS>;

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

/**
 * Author type classification
 */
export type AuthorType = TupleValue<typeof AUTHOR_TYPES>;

/**
 * Console log level for overlay diagnostics
 */
export type LogLevel = TupleValue<typeof LOG_LEVELS>;

/**
 * Author display settings (per author type)
 */
export type AuthorDisplaySettings = Record<AuthorDisplayKey, boolean>;

/**
 * Emoji/Emoticon information
 */
export interface EmojiInfo {
  /** Emoji type classification */
  type: EmojiType;
  /** Image URL (sanitized, YouTube CDN only) */
  url: string;
  /** Alt text (e.g., ":emoji_name:") */
  alt: string;
  /** Original width (optional, for aspect ratio) */
  width?: number;
  /** Original height (optional, for aspect ratio) */
  height?: number;
  /** Emoji ID (for caching/identification) */
  id?: string;
}

/**
 * Content segment (text or emoji)
 */
export interface TextContentSegment {
  type: 'text';
  content: string;
}

export interface EmojiContentSegment {
  type: 'emoji';
  emoji: EmojiInfo;
}

export type ContentSegment = TextContentSegment | EmojiContentSegment;

/**
 * Super Chat tier information
 */
export interface SuperChatInfo {
  /** Purchase amount (e.g., "5.00") */
  amount: string;
  /** Currency code (e.g., "USD", "JPY", "KRW") */
  currency?: string;
  /** Super Chat color tier (determines prominence) */
  tier: SuperChatTier;
  /** Background color from YouTube */
  backgroundColor?: string;
  /** Header background color (darker shade) */
  headerBackgroundColor?: string;
  /** Sticker image URL (for high-tier Super Chats) */
  stickerUrl?: string;
}

/**
 * Chat message structure (normalized)
 */
export interface ChatMessage {
  /** Message text content (sanitized, max 80 chars) - plain text only */
  text: string;
  /** Rich content segments (text + emoji) - for rendering mixed content */
  content?: ContentSegment[];
  /** Message type */
  kind: ChatMessageKind;
  /** Timestamp when the message was detected */
  timestamp: number;
  /** Author display name (optional, for future use) */
  author?: string;
  /** Author type classification */
  authorType?: AuthorType;
  /** Author photo URL (sanitized, YouTube CDN only) */
  authorPhotoUrl?: string;
  /** Super Chat information (only for kind='superchat') */
  superChat?: SuperChatInfo;
}

/**
 * Color settings for different author types
 */
export type ColorSettings = Record<AuthorType, string>;

/**
 * Outline settings for message text
 */
export interface OutlineSettings {
  /** Enable/disable text outline */
  enabled: boolean;
  /** Outline thickness in pixels */
  widthPx: number;
  /** Outline blur in pixels */
  blurPx: number;
  /** Outline opacity (0.0-1.0) */
  opacity: number;
}

/**
 * Overlay settings
 */
export interface OverlaySettings {
  /** Enable/disable overlay */
  enabled: boolean;
  /** Speed in pixels per second (100-400) */
  speedPxPerSec: number;
  /** Font size in pixels */
  fontSize: number;
  /** Opacity (0.0-1.0) */
  opacity: number;
  /** Super Chat color opacity (0.35-1.0) */
  superChatOpacity: number;
  /** Safe zone top percentage (0.0-1.0) */
  safeTop: number;
  /** Safe zone bottom percentage (0.0-1.0) */
  safeBottom: number;
  /** Maximum concurrent messages */
  maxConcurrentMessages: number;
  /** Maximum messages per second (1-20) */
  maxMessagesPerSecond: number;
  /** Allow short plain-text messages below minTextLength threshold */
  allowShortTextMessages: boolean;
  /** Minimum visible character count for regular plain text messages (1-10) */
  minTextLength: number;
  /** Console log level for overlay diagnostics */
  logLevel: LogLevel;
  /** Author display settings */
  showAuthor: AuthorDisplaySettings;
  /** Color settings for different author types */
  colors: ColorSettings;
  /** Text outline settings */
  outline: OutlineSettings;
  /** Vertical spacing between lanes in pixels (0 = tight, higher = more gap) */
  laneSpacing: number;
}

/**
 * Lane state for message flow
 */
export interface LaneState {
  /** Lane index */
  index: number;
  /** Last item exit time (timestamp) */
  lastItemExitTime: number;
  /** Last item start time (timestamp) */
  lastItemStartTime: number;
  /** Last item width in pixels */
  lastItemWidthPx: number;
  /** Last item height in pixels */
  lastItemHeightPx: number;
}

/**
 * Overlay dimensions
 */
export interface OverlayDimensions {
  width: number;
  height: number;
  laneHeight: number;
  laneCount: number;
}

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

/**
 * Shared setting bounds used by UI and runtime clamping.
 */
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

/**
 * Default settings
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  /**
   * Faster scrolling = messages leave the screen sooner, reducing visual clutter.
   * 280 px/s keeps text readable while minimising how long it occludes the video.
   */
  speedPxPerSec: 280,
  /** Smaller font reduces the area of video blocked per message. */
  fontSize: 20,
  /**
   * Semi-transparent so the video is still visible through overlay text.
   * 0.85 gives good legibility without fully blocking the picture.
   */
  opacity: 0.85,
  /** Super Chat card tint opacity – lower = more transparent over video. */
  superChatOpacity: 0.35,
  /** Start from the very top of the video (no top safe zone). */
  safeTop: 0,
  /**
   * Keep the bottom 40 % clear so comments only cover the top 60 % of the
   * video area (safeTop 0 % + active 60 % + safeBottom 40 % = 100 %).
   */
  safeBottom: 0.4,
  /**
   * Soft cap for performance monitoring (not strictly enforced).
   * Raised from 30 → 40 to accommodate the additional lanes created by the
   * tighter BASE_LANE_HEIGHT_MULTIPLIER.
   */
  maxConcurrentMessages: 40,
  /**
   * Hard rate limit: at most 6 messages per second reach the overlay.
   * Raised from 4 → 6 for a denser default display while remaining readable.
   */
  maxMessagesPerSecond: 6,
  /** Keep strict mode by default to reduce chat noise. */
  allowShortTextMessages: false,
  /** Require at least 3 visible characters for regular messages. */
  minTextLength: 3,
  /** Default to warnings/errors only for a clean console. */
  logLevel: 'warn',
  /** Keep author labels selective to reduce visual noise by default. */
  showAuthor: DEFAULT_SHOW_AUTHOR,
  /** Author colors mirror familiar YouTube semantics for quick recognition. */
  colors: DEFAULT_COLORS,
  /** Light outline preserves readability on bright video frames. */
  outline: DEFAULT_OUTLINE,
  /** No extra vertical gap – the tight BASE_LANE_HEIGHT_MULTIPLIER already
   *  gives a compact layout; increase this to add breathing room between lanes. */
  laneSpacing: 0,
} as const satisfies Readonly<OverlaySettings>;
