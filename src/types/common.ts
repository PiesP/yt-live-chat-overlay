// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export type {
  LanguageSetting,
  TranslationLanguage,
  TranslationSource,
  TranslationSourceLanguage,
  TranslationTarget,
} from '@i18n/language-domains';

/** Author type classification */
export type AuthorType = 'normal' | 'member' | 'moderator' | 'owner' | 'verified';
/** Console log level for overlay diagnostics */
export type LogLevel = 'warn' | 'info' | 'debug';
export type AuthorDisplayKey =
  | 'normal'
  | 'member'
  | 'moderator'
  | 'owner'
  | 'verified'
  | 'superChat';
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
  | 'oversized'
  | 'reflow_capacity'
  | 'replay_late'
  | 'temporarily_unavailable'
  | 'worker_backpressure';
/** Backlog injection modes */
export type BacklogMode = 'playback' | 'recent' | 'full' | 'none';
/** Translation service provider */
export type TranslationService = 'auto' | 'off';
/** Translation display mode */
export type TranslationMode = 'dual' | 'replace';

/** RGB color representation (readonly, immutable). */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Font weight: normal (400) or bold (700). */
export type FontWeight = 'normal' | 'bold';

/** Burst level classification based on messages per second */
export type BurstLevel = 'normal' | 'elevated' | 'high' | 'extreme';

/** Shared image asset metadata */
export interface ImageAsset {
  url: string;
  candidateUrl?: string;
  alt: string;
  fallbackText?: string;
  width?: number;
  height?: number;
}

/** Content segment (text or emoji) */
export type ContentSegment = TextContentSegment | EmojiContentSegment;

export type TextContentSegment = {
  type: 'text';
  content: string;
};

export interface EmojiContentSegment {
  type: 'emoji';
  emoji: ImageAsset;
}
