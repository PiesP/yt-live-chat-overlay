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
type AuthorDisplayKey = 'normal' | 'member' | 'moderator' | 'owner' | 'verified' | 'superChat';
type ChatMessageKind = 'text' | 'superchat' | 'membership';
type SuperChatTier = 'blue' | 'cyan' | 'green' | 'yellow' | 'orange' | 'magenta' | 'red';

export const isLogLevel = (value: unknown): value is LogLevel =>
  value === 'warn' || value === 'info' || value === 'debug';

/**
 * Author display settings (per author type)
 */
export type AuthorDisplaySettings = Record<AuthorDisplayKey, boolean>;

/**
 * Shared image asset metadata
 */
export interface ImageAsset {
  /** Primary image URL (sanitized, YouTube CDN only) */
  url: string;
  /** Single fallback URL to try before visible text fallback */
  candidateUrl?: string;
  /** Accessible alt text */
  alt: string;
  /** Visible text used if the image cannot be rendered */
  fallbackText?: string;
  /** Original width (optional, for aspect ratio) */
  width?: number;
  /** Original height (optional, for aspect ratio) */
  height?: number;
}

/**
 * Image-based emoji/emoticon information
 */
export interface EmojiInfo extends ImageAsset {}

/**
 * Content segment (text or emoji)
 */
export type ContentSegment = TextContentSegment | EmojiContentSegment;

// Internal union constituents — use ContentSegment for external typing.
type TextContentSegment = {
  type: 'text';
  content: string;
};

type EmojiContentSegment = {
  type: 'emoji';
  emoji: EmojiInfo;
};

/**
 * Super Chat tier information
 */
export interface SuperChatInfo {
  /** Purchase amount (e.g., "5.00") */
  amount: string;
  /** Super Chat color tier (determines prominence) */
  tier: SuperChatTier;
  /** Background color from YouTube */
  backgroundColor?: string;
  /** Header background color (darker shade) */
  headerBackgroundColor?: string;
  /** Sticker image asset (for paid stickers / sticker-enhanced Super Chats) */
  sticker?: ImageAsset;
}

/**
 * Chat message structure (normalized)
 */
export interface ChatMessage {
  /** Stable YouTube message id for deduplication (from renderer DOM id). */
  id?: string;
  /** Derived plain-text fallback from content (sanitized, max 80 chars) */
  text: string;
  /** Canonical visible content segments used for rendering */
  content: ContentSegment[];
  /** Message type */
  kind: ChatMessageKind;
  /** Timestamp when the message was detected */
  timestamp: number;
  /** Author display name (optional, for future use) */
  author?: string;
  /** Author type classification */
  authorType: AuthorType;
  /** Author photo URL (sanitized, YouTube CDN only) */
  authorPhotoUrl?: string;
  /** Super Chat information (only for kind='superchat') */
  superChat?: SuperChatInfo;
  /** True when the message is part of a backlog injection (initial seed) */
  isBacklog?: boolean;
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
  /** Show debug overlay with real-time metrics */
  showDebugOverlay: boolean;

  // ── Author Rate Limiting ──
  /** Enable per-author rate limiting */
  authorRateLimitEnabled: boolean;
  /** Rate limit window in milliseconds */
  authorRateLimitWindowMs: number;
  /** Max messages per author per window */
  authorRateLimitMaxMessages: number;

  // ── Backlog Injection ──
  /** How to handle past chat messages on initial load */
  backlogMode: 'playback' | 'recent' | 'full' | 'none';
  /** Max backlog messages injected per second (0 = no limit) */
  backlogMaxRate: number;
  /** Speed multiplier for backlog message animations */
  backlogSpeedMultiplier: number;
  /** Show backlog loading indicator */
  showBacklogIndicator: boolean;
  /** For 'recent' mode: how many minutes of past chat to show (1-30) */
  backlogRecentMinutes: number;
}

/**
 * Session metrics snapshot for ObservabilityReporter
 */
export interface SessionMetrics {
  totalReceived: number;
  totalRendered: number;
  totalDropped: number;
  dropRate: number; // 0-1, rolling window ~60s
  queueDepth: number;
  burstLevel: BurstLevel;
  activeMessages: number;
  laneUtilization: number; // 0-1
  backlogProgress: number; // 0-1 (when in backlog injection phase)
}

/**
 * Reason why a message was dropped
 */
export type DropReason =
  | 'queue_overflow'
  | 'no_lane_available'
  | 'rate_limited'
  | 'sampled'
  | 'dedup'
  | 'other';

/**
 * Burst level classification based on messages per second
 */
export type BurstLevel = 'normal' | 'elevated' | 'high' | 'extreme';

/**
 * Lane state for message flow
 */
export interface LaneState {
  /** Lane index */
  index: number;
  /** Last item start time (timestamp) */
  lastItemStartTime: number;
  /** Last item animation end time (timestamp) — hard deadline before next message can start. */
  lastItemEndTime: number;
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
