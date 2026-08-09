// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Type definitions for YouTube Live Chat Overlay
 *
 * Domain-split into common, chat, settings, and renderer modules.
 * Re-exported here so consumers can always `import { ... } from '@app-types'`.
 */

export type { AccessibleChatMessage, ChatMessage, SuperChatInfo } from './chat';
export type {
  AuthorRateLimitPreset,
  AuthorType,
  BacklogMode,
  BurstLevel,
  ContentSegment,
  DanmakuMode,
  DropReason,
  FontWeight,
  ImageAsset,
  LanguageSetting,
  LogLevel,
  RgbColor,
  SuperChatTier,
  TranslationLanguage,
  TranslationMode,
  TranslationService,
  TranslationSource,
  TranslationSourceLanguage,
  TranslationTarget,
} from './common';
export type { FrameTimings, Pauseable, SessionMetrics } from './renderer';
export type { OutlineSettings, OverlayDimensions, OverlaySettings } from './settings';
