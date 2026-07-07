// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Type definitions for YouTube Live Chat Overlay
 *
 * Domain-split into common, chat, settings, and renderer modules.
 * Re-exported here so consumers can always `import { ... } from '@app-types'`.
 */

export type { ChatMessage, SuperChatInfo } from './chat';
export type {
  AuthorDisplayKey,
  AuthorRateLimitPreset,
  AuthorType,
  BacklogMode,
  BurstLevel,
  ChatMessageKind,
  ContentSegment,
  DanmakuMode,
  DropReason,
  EmojiContentSegment,
  FontWeight,
  ImageAsset,
  LanguageSetting,
  LogLevel,
  RgbColor,
  SuperChatTier,
  TextContentSegment,
  TranslationLanguage,
  TranslationMode,
  TranslationService,
  TranslationSource,
  TranslationTarget,
} from './common';
export type { FrameTimings, Pauseable, SessionMetrics } from './renderer';
export type {
  AuthorDisplaySettings,
  ColorSettings,
  OutlineSettings,
  OverlayDimensions,
  OverlaySettings,
} from './settings';
