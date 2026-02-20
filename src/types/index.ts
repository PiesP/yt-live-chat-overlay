/**
 * Type definitions for YouTube Live Chat Overlay
 */

/**
 * Author type classification
 */
export type AuthorType = 'normal' | 'member' | 'moderator' | 'owner' | 'verified';

/**
 * Console log level for overlay diagnostics
 */
export type LogLevel = 'warn' | 'info' | 'debug';

/**
 * Author display settings (per author type)
 */
export interface AuthorDisplaySettings {
  /** Show author for normal users */
  normal: boolean;
  /** Show author for members */
  member: boolean;
  /** Show author for moderators */
  moderator: boolean;
  /** Show author for channel owner */
  owner: boolean;
  /** Show author for verified users */
  verified: boolean;
  /** Show author for Super Chats */
  superChat: boolean;
}

/**
 * Emoji/Emoticon information
 */
export interface EmojiInfo {
  /** Emoji type classification */
  type: 'standard' | 'custom' | 'member';
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
export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'emoji'; emoji: EmojiInfo };

/**
 * Super Chat tier information
 */
export interface SuperChatInfo {
  /** Purchase amount (e.g., "5.00") */
  amount: string;
  /** Currency code (e.g., "USD", "JPY", "KRW") */
  currency?: string;
  /** Super Chat color tier (determines prominence) */
  tier: 'blue' | 'cyan' | 'green' | 'yellow' | 'orange' | 'magenta' | 'red';
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
  kind: 'text' | 'superchat' | 'membership';
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
export interface ColorSettings {
  /** Normal user color */
  normal: string;
  /** Member (membership subscriber) color */
  member: string;
  /** Moderator color */
  moderator: string;
  /** Channel owner color */
  owner: string;
  /** Verified user color */
  verified: string;
}

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

/**
 * Shared setting bounds used by UI and runtime clamping.
 */
export const SETTINGS_LIMITS = {
  speedPxPerSec: { min: 100, max: 400, step: 10 },
  fontSize: { min: 18, max: 40, step: 2 },
  opacity: { min: 0.5, max: 1, step: 0.05 },
  superChatOpacity: { min: 0.35, max: 1, step: 0.05 },
  safeTop: { min: 0, max: 0.25, step: 0.01 },
  safeBottom: { min: 0, max: 0.25, step: 0.01 },
  maxConcurrentMessages: { min: 30, max: 100, step: 10 },
  maxMessagesPerSecond: { min: 1, max: 20, step: 1 },
  minTextLength: { min: 1, max: 10, step: 1 },
  outlineWidthPx: { min: 0, max: 5, step: 0.5 },
  outlineBlurPx: { min: 0, max: 8, step: 0.5 },
  outlineOpacity: { min: 0, max: 1, step: 0.1 },
} as const;

/**
 * Default settings
 */
export const DEFAULT_SETTINGS: Readonly<OverlaySettings> = {
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
  /** Keep the top 10 % clear (title bar / stream info area). */
  safeTop: 0.1,
  /**
   * Keep the bottom 15 % clear (player controls, chat toggle, etc.).
   * Slightly larger than the old default to avoid covering the control bar.
   */
  safeBottom: 0.15,
  /** Soft cap for performance monitoring (not strictly enforced). */
  maxConcurrentMessages: 30,
  /**
   * Hard rate limit: at most 4 messages per second reach the overlay.
   * Keeps the screen from becoming unreadable during chat bursts.
   */
  maxMessagesPerSecond: 4,
  /** Keep strict mode by default to reduce chat noise. */
  allowShortTextMessages: false,
  /** Require at least 3 visible characters for regular messages. */
  minTextLength: 3,
  /** Default to warnings/errors only for a clean console. */
  logLevel: 'warn',
  showAuthor: {
    /** Hide author names for regular users – reduces visual noise. */
    normal: false,
    /** Hide member names by default – membership badge already signals this. */
    member: false,
    /** Always show moderator names so viewers can identify them. */
    moderator: true,
    /** Always show channel owner name. */
    owner: true,
    /** Verified users look like normal users visually – hide by default. */
    verified: false,
    /** Super Chat author is essential context for the purchase. */
    superChat: true,
  },
  colors: {
    normal: '#FFFFFF', // White – neutral and readable on any background
    member: '#0F9D58', // Green – matches YouTube's membership colour
    moderator: '#5E84F1', // Blue – matches YouTube's moderator badge colour
    owner: '#FFD600', // Gold – clearly signals the channel owner
    verified: '#AAAAAA', // Grey – de-emphasised; treated like a normal viewer
  },
  outline: {
    enabled: true,
    widthPx: 1.5,
    blurPx: 2,
    opacity: 0.7,
  },
};
