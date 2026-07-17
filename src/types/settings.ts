// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type {
  AuthorDisplayKey,
  AuthorRateLimitPreset,
  AuthorType,
  BacklogMode,
  DanmakuMode,
  FontWeight,
  LanguageSetting,
  LogLevel,
  TranslationMode,
  TranslationService,
  TranslationSource,
  TranslationTarget,
} from './common';

/** Author display settings (per author type) */
export type AuthorDisplaySettings = Record<AuthorDisplayKey, boolean>;
/** Color settings for different author types */
export type ColorSettings = Record<AuthorType, string>;

/** Text outline settings */
export interface OutlineSettings {
  enabled: boolean;
  widthPx: number;
  opacity: number;
}

/** Overlay settings */
export interface OverlaySettings {
  enabled: boolean;
  danmakuMode: DanmakuMode;
  speedPxPerSec: number;
  fontSize: number;
  opacity: number;
  superChatOpacity: number;
  safeTop: number;
  safeBottom: number;
  maxConcurrentMessages: number;
  allowShortTextMessages: boolean;
  minTextLength: number;
  logLevel: LogLevel;
  showAuthor: AuthorDisplaySettings;
  colors: ColorSettings;
  outline: OutlineSettings;
  laneSpacing: number;
  fontWeight: FontWeight;
  fontFamily: string;
  showDebugOverlay: boolean;
  ignoreReducedMotion: boolean;
  authorRateLimit: AuthorRateLimitPreset;
  backlogMode: BacklogMode;
  backlogMaxRate: number;
  backlogSpeedMultiplier: number;
  backlogRecentMinutes: number;
  backlogOpacityMultiplier: number;
  depthLayersEnabled: boolean;
  depthNearSpeedMul: number;
  depthFarSpeedMul: number;
  depthFarOpacityMul: number;
  /** Enable motion blur (ghost rendering) for FAR-tier messages. */
  motionBlurEnabled: boolean;
  /** Motion blur ghost alpha (0.01–0.05). Only used when motionBlurEnabled is true. */
  motionBlurAlpha: number;
  modOwnerDurationMultiplier: number;
  showSuperChatAmount: boolean;
  preserveUserColor: boolean;
  superChatMaxBodyLines: number;
  membershipMaxBodyLines: number;
  fadeDurationMs: number;
  minPollIntervalMs: number;
  maxPollIntervalMs: number;
  language: LanguageSetting;
  translationEnabled: boolean;
  translationService: TranslationService;
  translationSource: TranslationSource;
  translationTarget: TranslationTarget;
  translationMode: TranslationMode;
  exitPaddingPx: number;
  scrollDurationMinMs: number;
  scrollDurationMaxMs: number;
  topBottomDurationMs: number;
  queueMaxSize: number;
  backgroundQueueMax: number;
  maxMessageAgeMs: number;
  headwayGapRatio: number;
  emojiCacheMb: number;
  photoCacheMb: number;
  stickerCacheMb: number;
  textCacheMb: number;
  translationBatchSize: number;
  emojiFetchLimit: number;
  failedEmojiRetryMins: number;
  burstSampleWindow: number;
  burstElevatedThreshold: number;
  burstHighThreshold: number;
  burstExtremeThreshold: number;
  backlogInjectionMax: number;
  backlogDensityRampMs: number;
  livePollFallbackMs: number;
  livePollFailureLimit: number;
  speedBoostThreshold: number;
  backlogPauseThreshold: number;
  backlogResumeThreshold: number;
  activityTimeoutMs: number;
  staggerMaxDelayMs: number;
  staggerMediumDelayMs: number;
  emojiFetchTimeoutMs: number;
  backlogDensityRampMaxMs: number;
  backlogInjectionRateMin: number;
  speedBoostMax: number;
  speedBoostDenom: number;
  backlogToggleCooldownMs: number;
  replayPrefetchPages: number;
  replayBatchLimit: number;
}

/** Overlay dimensions — pure pixel measurements from the player container. */
export interface OverlayDimensions {
  width: number;
  height: number;
}
