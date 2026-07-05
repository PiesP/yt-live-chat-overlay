// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared types for the renderer-worker module.
 *
 * Extracted from renderer-worker.ts to reduce file size and clarify
 * the boundary between type definitions and rendering logic.
 */

import type { FontWeight } from '@app-types';
import type { CardConfigWorker } from '@core/card-config';

// ── Types ─────────────────────────────────────────────────────────────────

export interface WorkerConfig {
  /** Pixels per second scroll speed (100–400). */
  speedPxPerSec: number;
  /** Font size in logical pixels. */
  fontSize: number;
  /** Font weight: 'normal' | 'bold'. */
  fontWeight: FontWeight;
  /** CSS font-family value. */
  fontFamily: string;
  /** Base opacity (0–1). */
  opacity: number;
  /** Vertical lane spacing in px. */
  laneSpacing: number;
  /** Safe zone top ratio (0–1). */
  safeTop: number;
  /** Safe zone bottom ratio (0–1). */
  safeBottom: number;
  /** Max concurrent messages on screen. */
  maxConcurrentMessages: number;
  /** Danmaku mode. */
  danmakuMode: 'scroll' | 'reverse' | 'top' | 'bottom';
  /** Backlog speed multiplier. */
  backlogSpeedMultiplier: number;
  /** Depth layers enabled. */
  depthLayersEnabled: boolean;
  /** Far-layer speed multiplier. */
  depthFarSpeedMul: number;
  /** Near-layer speed multiplier. */
  depthNearSpeedMul: number;
  /** Far-layer opacity multiplier. */
  depthFarOpacityMul: number;
  /** Backlog opacity multiplier. */
  backlogOpacityMultiplier: number;
  /** Fade-out duration in ms. */
  fadeDurationMs: number;
  /** Max message age for age-based fade-out (ms). */
  maxMessageAgeMs: number;
  /** Text color (CSS string) for regular messages. */
  color: string;
  /** Per-author-type color map (CSS strings). */
  authorColors: Record<string, string>;
  /** Duration multiplier for moderator/owner messages. */
  modOwnerDurationMultiplier: number;
  /** Outline width in px. */
  outlineWidthPx: number;
  /** Outline opacity. */
  outlineOpacity: number;
  /** SuperChat color opacity (0.35–1.0). */
  superChatOpacity: number;
  /** Maximum body text lines for SuperChat cards. */
  superChatMaxBodyLines: number;
  /** Maximum body text lines for Membership messages. */
  membershipMaxBodyLines: number;
  /** Author display settings (per-authorType visibility). */
  showAuthor: Record<string, boolean>;
  /** Translation enabled flag. */
  translationEnabled: boolean;
  /** Translation display mode: 'dual' or 'replace'. */
  translationMode: 'dual' | 'replace';
  /** Toggle Super Chat purchase amount badge display. */
  showSuperChatAmount: boolean;
  /** Extra pixels past screen edge before exit (px). */
  exitPaddingPx: number;
  /** Minimum scroll animation duration (ms). */
  scrollDurationMinMs: number;
  /** Maximum scroll animation duration (ms). */
  scrollDurationMaxMs: number;
  /** Display duration for top/bottom mode (ms). */
  topBottomDurationMs: number;
  /** Headway gap as fraction of message width (0-1). */
  headwayGapRatio: number;
  /** Max pending queue depth. */
  queueMaxSize: number;
  /** Background queue trim target. */
  backgroundQueueMax: number;
  /** Emoji image cache budget in MB. */
  emojiCacheMb: number;
  /** Author photo cache budget in MB. */
  photoCacheMb: number;
  /** Sticker image cache budget in MB. */
  stickerCacheMb: number;
  /** Text bitmap cache budget in MB. */
  textCacheMb: number;
  /** Max translations to apply per frame. */
  translationBatchSize: number;
  /** Max concurrent emoji fetch operations. */
  emojiFetchLimit: number;
  /** Minutes before retrying failed emoji fetches. */
  failedEmojiRetryMins: number;
  staggerMaxDelayMs: number;
  /** Medium stagger delay for moderate queue depth (ms). Mirrors OverlaySettings.staggerMediumDelayMs. */
  staggerMediumDelayMs: number;
  emojiFetchTimeoutMs: number;
  /** Ignore OS reduced-motion preference (user override). Mirrors OverlaySettings.ignoreReducedMotion. */
  ignoreReducedMotion: boolean;
  /** OS prefers-reduced-motion media query result (relayed from main thread; Workers lack matchMedia). */
  reducedMotion: boolean;
}

export interface WorkerContentSegment {
  type: 'text' | 'emoji';
  /** Text content, OR emoji character. */
  content: string;
  /** Emoji image URL (only for type='emoji'). */
  emojiUrl?: string;
  /** Emoji alt text fallback (only for type='emoji'). */
  emojiAlt?: string;
}

export interface WorkerMessage {
  /** Unique message ID. */
  id: string;
  /** Plain text content (pre-extracted). */
  text: string;
  /** Width/height estimates (computed on main thread). */
  width: number;
  height: number;
  /** Priority: 100+ = superchat, 80 = membership, 50 = mod/owner, 0 = normal. */
  priority: number;
  /** Whether this is a backlog (past chat) message. */
  isBacklog: boolean;
  /** Translated text (if available). */
  translatedText?: string;
  /** Author type for color selection: normal, moderator, owner, member, etc. */
  authorType?: string;
  /** Message kind: 'chat', 'superchat', 'membership', etc. */
  kind?: string;
  /** Burst speed multiplier computed by main thread (>= 1.0). */
  burstSpeedMultiplier?: number;
  /** Content segments: text + emoji with URLs. */
  content?: WorkerContentSegment[];
  /** Author display name. */
  author?: string;
  /** Author photo URL. */
  authorPhotoUrl?: string;
  // ── SuperChat card data ──
  /** Formatted amount string (e.g. "$5.00"). */
  superChatAmount?: string;
  /** Sticker image URL. */
  superChatStickerUrl?: string;
  /** Membership header text (e.g. member tier/duration). */
  membershipHeader?: string;
  /** Optional CardConfigWorker for config-driven renderPaidCardWorker(). */
  cardConfigWorker?: CardConfigWorker;
}

export interface ActiveMessage {
  id: string;
  x: number;
  y: number;
  startX: number;
  width: number;
  height: number;
  /** Position/animation start time (includes stagger delay). */
  startTime: number;
  /** Opacity/fade start time (matches main thread fadeStartTime = now + staggerDelay). */
  fadeStartTime: number;
  duration: number;
  /** Pre-computed 1/duration for per-frame multiplication (avoids division). */
  invDuration: number;
  pausedDuration: number;
  laneIndex: number;
  laneSlotCount: number;
  speedTier: number;
  text: string;
  /** Per-author color CSS string. */
  color: string;
  /** Author type for stats/desaturation. */
  authorType?: string;
  /** Message kind for speed tiering. */
  kind?: string;
  /** Translated text for dual/replace display. */
  translatedText?: string;
  /** Desaturated color for far-depth layer. */
  colorOverride?: string;
  /** Content segments for emoji/text rendering. */
  content?: WorkerContentSegment[];
  /** Author display name. */
  author?: string;
  /** Author photo URL. */
  authorPhotoUrl?: string;
  /** Formatted SuperChat amount (e.g. "$5.00"). */
  superChatAmount?: string;
  /** SuperChat sticker image URL. */
  superChatStickerUrl?: string;
  /** Membership header text. */
  membershipHeader?: string;
  /** Optional CardConfigWorker for config-driven renderPaidCardWorker(). */
  cardConfigWorker?: CardConfigWorker;
  /** Transient frame-local elapsed (ms). Set by renderFrame pre-scan, used by
   *  bucket rendering. Not serialized — re-set each frame. */
  _frameElapsed?: number;
}
