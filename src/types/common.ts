// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { Locale, SettingLocale } from '@piesp/browser-core/locale';

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
  | 'temporarily_unavailable'
  | 'worker_backpressure';
/** Backlog injection modes */
export type BacklogMode = 'playback' | 'recent' | 'full' | 'none';
/** Language setting: auto-detect or explicit locale */
export type LanguageSetting = SettingLocale;
/** Translation service provider */
export type TranslationService = 'auto' | 'off';
/** Translation display mode */
export type TranslationMode = 'dual' | 'replace';
/** Valid source/target languages for translation (excludes 'auto') */
export type TranslationLanguage = Locale;
/** BCP 47 source languages returned by detection, including Chinese script variants. */
export type TranslationSourceLanguage = TranslationLanguage | 'zh-Hans' | 'zh-Hant';
/** Target language for translation — 'auto' resolves to browser language via navigator.language */
export type TranslationTarget = SettingLocale;
/** Source language for translation — 'auto' uses Chrome Language Detector API or Unicode heuristics */
export type TranslationSource = SettingLocale;

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
