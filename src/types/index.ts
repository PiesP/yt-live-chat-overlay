// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

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
export type ChatMessageKind = 'text' | 'superchat' | 'membership';
export type DanmakuMode = 'scroll' | 'reverse' | 'top' | 'bottom';
export type SuperChatTier = 'blue' | 'cyan' | 'green' | 'yellow' | 'orange' | 'magenta' | 'red';
/** Author rate-limiting preset modes */
export type AuthorRateLimitPreset = 'off' | 'normal' | 'strict';
/** Drop reason for observability tracking */
export type DropReason =
  | 'video_paused'
  | 'rate_limited'
  | 'queue_priority'
  | 'queue_replaced'
  | 'collision'
  | 'no_lane'
  | 'worker_backpressure';
/** Backlog injection modes */
export type BacklogMode = 'playback' | 'recent' | 'full' | 'none';
/** Language setting: auto-detect or explicit locale */
export type LanguageSetting = 'auto' | 'en' | 'ko' | 'ja' | 'es' | 'zh';
/** Translation service provider */
export type TranslationService = 'auto' | 'off';
/** Translation display mode */
export type TranslationMode = 'dual' | 'replace';
/** Valid source/target languages for translation (excludes 'auto') */
export type TranslationLanguage = 'en' | 'ko' | 'ja' | 'es' | 'zh';
/** Target language for translation — 'auto' resolves to browser language via navigator.language */
export type TranslationTarget = TranslationLanguage | 'auto';
/** Source language for translation — 'auto' uses Chrome Language Detector API or Unicode heuristics */
export type TranslationSource = TranslationLanguage | 'auto';

/** RGB color representation (readonly, immutable). */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Font weight: normal (400) or bold (700). */
export type FontWeight = 'normal' | 'bold';

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
 * Content segment (text or emoji)
 */
export type ContentSegment = TextContentSegment | EmojiContentSegment;

// Internal union constituents — use ContentSegment for external typing.
type TextContentSegment = {
  type: 'text';
  content: string;
};

export interface EmojiContentSegment {
  type: 'emoji';
  emoji: ImageAsset;
}

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
  /** Author's self-chosen text color from YouTube chat (CSS hex/rgb string) */
  userColor?: string;
  /** Super Chat information (only for kind='superchat') */
  superChat?: SuperChatInfo;
  /** Membership tier/duration header text (e.g., "New Member", "Member for 12 months") */
  membershipHeader?: string;
  /** True when the message is part of a backlog injection (initial seed) */
  isBacklog?: boolean;
  /** YouTube video offset in milliseconds (from videoOffsetTimeMsec, replay only) */
  videoOffsetMs?: number;
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
  /** Outline opacity (0.0-1.0) */
  opacity: number;
}

/**
 * Overlay settings
 */
export interface OverlaySettings {
  /** Enable/disable overlay */
  enabled: boolean;
  /** Enable WebGL2 SDF text renderer (falls back to Canvas2D if unavailable) */
  enableWebGL2: boolean;
  /** Danmaku comment display mode */
  danmakuMode: DanmakuMode;
  /** Speed in pixels per second (50-500) */
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
  /** Vertical spacing between lanes in pixels (negative = overlap, 0 = tight, higher = more gap) */
  laneSpacing: number;
  /** Text font weight: normal (400) or bold (700) */
  fontWeight: FontWeight;
  /** Font family (CSS font-family value, e.g. 'Noto Sans KR, sans-serif') */
  fontFamily: string;
  /** Show debug overlay with real-time metrics */
  showDebugOverlay: boolean;

  // ── Author Rate Limiting ──
  /** Per-author rate limiting preset */
  authorRateLimit: AuthorRateLimitPreset;

  // ── Backlog Injection ──
  /** How to handle past chat messages on initial load */
  backlogMode: BacklogMode;
  /** Max backlog messages injected per second (0 = no limit) */
  backlogMaxRate: number;
  /** Speed multiplier for backlog message animations */
  backlogSpeedMultiplier: number;
  /** For 'recent' mode: how many minutes of past chat to show (1-30) */
  backlogRecentMinutes: number;
  /** Backlog message opacity multiplier (0.1-1.0, default 0.75 = 75% of live opacity) */
  backlogOpacityMultiplier: number;
  /** Enable multi-layer depth effect via speed variation (off by default) */
  depthLayersEnabled: boolean;
  /** Speed multiplier for Near layer messages (1.0-2.0, default 1.4) */
  depthNearSpeedMul: number;
  /** Speed multiplier for Far layer messages (0.3-1.0, default 0.8) */
  depthFarSpeedMul: number;
  /** Opacity multiplier for Far layer messages (0.4-1.0, default 0.65) */
  depthFarOpacityMul: number;
  /** Duration multiplier for moderator and owner messages (1.0-3.0, default 1.5).
   *  1.0 = same duration as regular messages, 2.0 = twice as long. */
  modOwnerDurationMultiplier: number;
  /** Toggle Super Chat purchase amount badge display */
  showSuperChatAmount: boolean;
  /** Preserve author's chosen text color from YouTube chat */
  preserveUserColor: boolean;
  /** Maximum body text lines for SuperChat cards (2-10, default 5) */
  superChatMaxBodyLines: number;
  /** Maximum body text lines for Membership messages (1-5, default 3) */
  membershipMaxBodyLines: number;

  // ── Fade / Poll Timing ──
  fadeDurationMs: number;
  /** Minimum polling interval in milliseconds */
  minPollIntervalMs: number;
  /** Maximum polling interval in milliseconds */
  maxPollIntervalMs: number;
  /** UI language: auto-detect or explicit locale */
  language: LanguageSetting;

  // ── Translation ──
  /** Enable real-time chat translation */
  translationEnabled: boolean;
  /** Translation service provider */
  translationService: TranslationService;
  /** Source language for translation (language messages are written in). 'auto' uses language detection. */
  translationSource: TranslationSource;
  /** Target language for translation (language to translate into). 'auto' resolves via browser language. */
  translationTarget: TranslationTarget;
  /** Display mode: dual (original + translation) or replace (translation only) */
  translationMode: TranslationMode;

  // ── Layout / Timing ──
  /** Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100) */
  exitPaddingPx: number;
  /** Minimum scroll animation duration in ms — prevents very short messages from zipping across (1000-15000, default 5000) */
  scrollDurationMinMs: number;
  /** Maximum scroll animation duration in ms — prevents very long messages from crawling (5000-120000, default 30000) */
  scrollDurationMaxMs: number;
  /** Fixed display duration for top/bottom mode messages in ms (1000-30000, default 4000) */
  topBottomDurationMs: number;

  // ── Queue / Lifetime ──
  /** Maximum pending queue depth before messages are dropped (50-1000, default 200) */
  queueMaxSize: number;
  /** Target active message count when trimming background tab (10-500, default 50) */
  backgroundQueueMax: number;
  /** Maximum message age in ms before fade-out removal (10000-300000, default 60000) */
  maxMessageAgeMs: number;

  // ── Lane Spacing ──
  /** Headway gap ratio: fraction of message width used as gap between consecutive messages (0.02-0.30, default 0.08 = 8%) */
  headwayGapRatio: number;

  // ── Performance ──
  /** Emoji cache size in MB (1-20, default 3) */
  emojiCacheMb: number;
  /** Photo cache size in MB (1-20, default 2) */
  photoCacheMb: number;
  /** Sticker cache size in MB (1-20, default 1) */
  stickerCacheMb: number;
  /** Text bitmap cache size in MB (1-20, default 4) */
  textCacheMb: number;
  /** Max translation results to apply per frame (1-20, default 5) */
  translationBatchSize: number;
  /** Max concurrent emoji fetch operations (1-20, default 6) */
  emojiFetchLimit: number;
  /** Failed emoji retry TTL in minutes (1-60, default 5) */
  failedEmojiRetryMins: number;

  // ── Advanced / Thresholds ──
  /** Burst rate sample window size (3-60, default 10) */
  burstSampleWindow: number;
  /** Elevated burst msg/s threshold (>5 msg/s) */
  burstElevatedThreshold: number;
  /** High burst msg/s threshold (>15 msg/s) */
  burstHighThreshold: number;
  /** Extreme burst msg/s threshold (>30 msg/s) */
  burstExtremeThreshold: number;
  /** Max backlog injection rate cap (5-100, default 20) */
  backlogInjectionMax: number;
  /** Density ramp duration in ms (500-10000, default 2500) */
  backlogDensityRampMs: number;
  /** Live poll fallback delay in ms (500-30000, default 1500) */
  livePollFallbackMs: number;
  /** Consecutive poll failures before backoff (3-50, default 10) */
  livePollFailureLimit: number;
  /** Pending messages threshold to trigger speed boost (2-50, default 5) */
  speedBoostThreshold: number;
  /** Lane utilization ratio to pause backlog injection (0.3-1.0, default 0.8) */
  backlogPauseThreshold: number;
  /** Lane utilization ratio to resume backlog injection (0.1-1.0, default 0.4) */
  backlogResumeThreshold: number;
  /** Chat activity timeout in ms (5000-120000, default 30000) */
  activityTimeoutMs: number;

  // ── Stagger / Tuning ──
  /** Max stagger delay for messages in same batch (ms) */
  staggerMaxDelayMs: number;
  /** Medium stagger delay when queue is medium depth (ms) */
  staggerMediumDelayMs: number;
  /** Timeout for emoji fetch operations (ms) */
  emojiFetchTimeoutMs: number;
  /** Max density ramp duration for backlog injection (ms) */
  backlogDensityRampMaxMs: number;
  /** Minimum backlog injection rate (msg/s) */
  backlogInjectionRateMin: number;
  /** Max speed boost factor for burst compensation */
  speedBoostMax: number;
  /** Speed boost denominator for EMA rate scaling */
  speedBoostDenom: number;
  /** Cooldown between backlog pause toggles (ms) */
  backlogToggleCooldownMs: number;
  /** Max pages to prefetch in replay mode */
  replayPrefetchPages: number;
  /** Max batches to fetch in replay initialization */
  replayBatchLimit: number;
}

/**
 * Per-frame timing instrumentation for the render pipeline.
 */
export interface FrameTimings {
  /** Rolling average (EMA) of renderFrame() execution time in ms. */
  renderFrameMs: number;
  /** Rolling average (EMA) of drainQueue() execution time in ms. */
  drainQueueMs: number;
  /** Average collision check time per frame (reset each tick). */
  collisionCheckMs: number;
  /** Average text measure time per frame (reset each tick). */
  textMeasureMs: number;
  /** Number of frames recorded since session start. */
  frameCount: number;
  /** Timestamp of the last recorded frame (ms). */
  lastFrameTimestamp: number;
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
  frameTimings: FrameTimings;
}

/**
 * Interface for objects that can be paused/resumed.
 * Implemented by ChatSource, BacklogInjectionController,
 * BurstDetector, and any other pause-aware subsystem.
 */
export interface Pauseable {
  setPaused(paused: boolean): void;
}

/**
 * Burst level classification based on messages per second
 */
export type BurstLevel = 'normal' | 'elevated' | 'high' | 'extreme';

/**
 * Overlay dimensions — pure pixel measurements from the player container.
 * Lane geometry (laneHeight, laneCount) is computed by LaneAllocator using
 * actual font metrics, so it is not included here.
 */
export interface OverlayDimensions {
  width: number;
  height: number;
}
