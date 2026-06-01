// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CardConfig — unified card configuration for SuperChat and Membership messages.
 *
 * Defines card appearance, behavior, and rendering hints. Factory functions
 * create complete configs using design-tokens and color-utils constants.
 */

import type { ChatMessage, OverlaySettings, RgbColor } from '@app-types';
import { computeReadableTextColor } from '@core/color-utils';
import {
  colors as designColors,
  rendererLayout,
  resolveSuperChatRgb,
  SUPERCHAT_AMOUNT_BADGE_FILL,
  SUPERCHAT_AMOUNT_BADGE_STROKE,
  spacing,
} from '@core/design-tokens';

export type BackgroundMode = 'gradient' | 'solid';
export type DecorationMode = 'accentBar' | 'pulsingBorder' | 'none';

/**
 * Worker-safe CardConfig — no callbacks, all pre-computed values for structured clone.
 */
export interface CardConfigWorker {
  background: BackgroundMode;
  backgroundGradient?: {
    topBoost: number;
    bottomReduction: number;
    minOpacity: number;
  };
  backgroundColor?: RgbColor;
  backgroundAlpha?: number;
  decoration: DecorationMode;
  accentBar?: {
    width: number;
    color: RgbColor; // pre-resolved, no callback
  };
  pulsingBorder?: {
    borderRgb: RgbColor;
    borderWidth: number;
    baseAlpha: number;
    amplitude: number;
  };
  badgeEnabled: boolean;
  badgeFillColor: string;
  badgeStrokeColor: string;
  badgeRadius: number;
  badgePaddingH: number;
  badgePaddingV: number;
  badgeStrokeWidth: number;
  headerTagEnabled: boolean;
  headerTagFontSizeScale: number;
  headerTagColor: string;
  headerTagMarginTop: number;
  headerTagMarginBottom: number;
  authorShow: boolean; // pre-resolved: does settings.showAuthor.superChat (or equivalent) allow it?
  authorNameMaxWidth: number;
  bodyMaxLines: number; // pre-resolved from settings
  bodyMarginTop: number;
  stickerEnabled: boolean;
  stickerSizeScale: number;
  stickerMarginTop: number;
  /** Whether to show the SuperChat amount badge (from settings.showSuperChatAmount). */
  showBadgeAmount: boolean;
  padding: { horizontal: number; vertical: number };
  cardRadius: number;
  textColor: string; // pre-resolved: either 'auto' result or explicit color
  accentBarColorRgb: RgbColor; // pre-resolved accent bar color
  resolveColorRgb: RgbColor; // pre-resolved resolveColor(message) result
  needsGradientCache: boolean;
  needsElapsed: boolean;
}

/**
 * Convert main-thread CardConfig to worker-safe CardConfigWorker by pre-resolving callbacks.
 * @param config The main-thread CardConfig with callbacks.
 * @param message The specific chat message to resolve per-message callbacks against.
 * @param settings The current overlay settings.
 */
export function toWorkerConfig(
  config: CardConfig,
  message: ChatMessage,
  settings: OverlaySettings
): CardConfigWorker {
  // Pre-resolve base colour
  const resolveColorRgb = config.resolveColor(message);
  const baseColor = `rgb(${resolveColorRgb.r}, ${resolveColorRgb.g}, ${resolveColorRgb.b})`;
  const textColor =
    config.textColor === 'auto' ? computeReadableTextColor(baseColor) : config.textColor;

  // Pre-resolve accent bar colour (function → RgbColor)
  let accentBarColorRgb: RgbColor = { r: 0, g: 0, b: 0 };
  if (config.accentBar) {
    const raw = config.accentBar.color;
    accentBarColorRgb = typeof raw === 'function' ? raw(message) : raw;
  }

  // Pre-resolve author visibility
  const authorShow =
    typeof config.authorSection.show === 'function'
      ? config.authorSection.show(message, settings)
      : config.authorSection.show;

  // Pre-resolve body max lines
  const bodyMaxLines =
    config.body.maxLines === 'fromSettings'
      ? message.kind === 'superchat'
        ? settings.superChatMaxBodyLines
        : settings.membershipMaxBodyLines
      : config.body.maxLines;

  return {
    background: config.background,
    backgroundGradient: config.backgroundGradient ?? undefined,
    backgroundColor: config.backgroundColor ? { ...config.backgroundColor } : undefined,
    backgroundAlpha: config.backgroundAlpha,
    decoration: config.decoration,
    accentBar: config.accentBar
      ? { width: config.accentBar.width, color: accentBarColorRgb }
      : undefined,
    pulsingBorder: config.pulsingBorder
      ? {
          borderRgb: config.pulsingBorder.borderRgb,
          borderWidth: config.pulsingBorder.borderWidth,
          baseAlpha: config.pulsingBorder.baseAlpha,
          amplitude: config.pulsingBorder.amplitude,
        }
      : undefined,
    badgeEnabled: config.badge?.enabled ?? false,
    badgeFillColor: config.badge?.fillColor ?? '',
    badgeStrokeColor: config.badge?.strokeColor ?? '',
    badgeRadius: config.badge?.radius ?? 0,
    badgePaddingH: config.badge?.paddingH ?? 0,
    badgePaddingV: config.badge?.paddingV ?? 0,
    badgeStrokeWidth: config.badge?.strokeWidth ?? 0,
    headerTagEnabled: config.headerTag?.enabled ?? false,
    headerTagFontSizeScale: config.headerTag?.fontSizeScale ?? 0.8,
    headerTagColor: config.headerTag?.color ?? '#ffffff',
    headerTagMarginTop: config.headerTag?.marginTop ?? 0,
    headerTagMarginBottom: config.headerTag?.marginBottom ?? 0,
    authorShow,
    authorNameMaxWidth: config.authorSection.nameMaxWidth,
    bodyMaxLines,
    bodyMarginTop: config.body.marginTop,
    stickerEnabled: config.sticker?.enabled ?? false,
    stickerSizeScale: config.sticker?.sizeScale ?? 0,
    stickerMarginTop: config.sticker?.marginTop ?? 0,
    showBadgeAmount: settings.showSuperChatAmount,
    padding: { ...config.padding },
    cardRadius: config.cardRadius,
    textColor,
    accentBarColorRgb,
    resolveColorRgb,
    needsGradientCache: config.needsGradientCache,
    needsElapsed: config.needsElapsed,
  } as CardConfigWorker;
}

export interface CardConfig {
  background: BackgroundMode;
  backgroundGradient?: {
    topBoost: number;
    bottomReduction: number;
    minOpacity: number;
  };
  backgroundColor?: RgbColor;
  backgroundAlpha?: number;
  decoration: DecorationMode;
  accentBar?: {
    width: number;
    color: RgbColor | ((message: ChatMessage) => RgbColor);
  };
  pulsingBorder?: {
    borderRgb: RgbColor;
    borderWidth: number;
    baseAlpha: number;
    amplitude: number;
  };
  badge?: {
    enabled: boolean;
    getText: (message: ChatMessage) => string | undefined;
    fillColor: string;
    strokeColor: string;
    radius: number;
    paddingH: number;
    paddingV: number;
    strokeWidth: number;
  };
  headerTag?: {
    enabled: boolean;
    getText: (message: ChatMessage) => string | undefined;
    fontSizeScale: number;
    color: string;
    marginTop: number;
    marginBottom: number;
  };
  authorSection: {
    show: boolean | ((message: ChatMessage, settings: OverlaySettings) => boolean);
    nameMaxWidth: number;
  };
  body: {
    maxLines: number | 'fromSettings';
    marginTop: number;
  };
  sticker?: {
    enabled: boolean;
    getUrl: (message: ChatMessage) => string | undefined;
    sizeScale: number;
    marginTop: number;
  };
  padding: { horizontal: number; vertical: number };
  cardRadius: number;
  textColor: string | 'auto';
  resolveColor: (message: ChatMessage) => RgbColor;
  needsGradientCache: boolean;
  needsElapsed: boolean;
}

export function createSuperChatCardConfig(): CardConfig {
  return {
    background: 'gradient',
    backgroundGradient: {
      topBoost: 0.12,
      bottomReduction: 0.15,
      minOpacity: 0.35,
    },
    decoration: 'accentBar',
    accentBar: {
      width: rendererLayout.superchatAccentBarWidth,
      color: (message: ChatMessage) => {
        const superChat = message.superChat;
        return resolveSuperChatRgb(superChat ?? { tier: 'blue' as const }, designColors.superChat);
      },
    },
    badge: {
      enabled: true,
      getText: (message: ChatMessage) => message.superChat?.amount,
      fillColor: SUPERCHAT_AMOUNT_BADGE_FILL,
      strokeColor: SUPERCHAT_AMOUNT_BADGE_STROKE,
      radius: rendererLayout.superchatBadge.radius,
      paddingH: rendererLayout.superchatBadge.paddingH,
      paddingV: rendererLayout.superchatBadge.paddingV,
      strokeWidth: rendererLayout.superchatBadgeStrokeWidth,
    },
    headerTag: {
      enabled: false,
      getText: () => undefined,
      fontSizeScale: 0.8,
      color: '#ffffff',
      marginTop: 0,
      marginBottom: 0,
    },
    authorSection: {
      show: (message: ChatMessage, settings: OverlaySettings) =>
        settings.showAuthor.superChat && !!message.author,
      nameMaxWidth: rendererLayout.authorNameMaxWidth,
    },
    body: {
      maxLines: 'fromSettings',
      marginTop: spacing.xs,
    },
    sticker: {
      enabled: true,
      getUrl: (message: ChatMessage) => message.superChat?.sticker?.url,
      sizeScale: rendererLayout.superchatStickerSize,
      marginTop: spacing.xs,
    },
    padding: {
      horizontal: rendererLayout.superchat.paddingH,
      vertical: rendererLayout.superchat.paddingV,
    },
    cardRadius: rendererLayout.superchatCardRadius,
    textColor: 'auto',
    resolveColor: (message: ChatMessage) => {
      const superChat = message.superChat;
      return resolveSuperChatRgb(superChat ?? { tier: 'blue' as const }, designColors.superChat);
    },
    needsGradientCache: true,
    needsElapsed: false,
  };
}

export function createMembershipCardConfig(): CardConfig {
  const mem = designColors.membership;
  return {
    background: 'solid',
    backgroundColor: mem.background,
    backgroundAlpha: mem.backgroundAlpha,
    decoration: 'pulsingBorder',
    pulsingBorder: {
      borderRgb: mem.borderRgb,
      borderWidth: rendererLayout.membershipBorderWidth,
      baseAlpha: mem.borderAlpha,
      amplitude: mem.borderAlphaAmplitude,
    },
    badge: {
      enabled: false,
      getText: () => undefined,
      fillColor: '',
      strokeColor: '',
      radius: 0,
      paddingH: 0,
      paddingV: 0,
      strokeWidth: 0,
    },
    headerTag: {
      enabled: true,
      getText: (message: ChatMessage) => message.membershipHeader,
      fontSizeScale: 0.8,
      color: mem.headerText,
      marginTop: 0,
      marginBottom: spacing.xs,
    },
    authorSection: {
      show: (message: ChatMessage) => !!message.author,
      nameMaxWidth: rendererLayout.authorNameMaxWidth,
    },
    body: {
      maxLines: 'fromSettings',
      marginTop: spacing.xs,
    },
    sticker: {
      enabled: false,
      getUrl: () => undefined,
      sizeScale: 0,
      marginTop: 0,
    },
    padding: {
      horizontal: rendererLayout.membership.paddingH,
      vertical: rendererLayout.membership.paddingV,
    },
    cardRadius: rendererLayout.membershipCardRadius,
    textColor: '#ffffff',
    resolveColor: () => mem.background,
    needsGradientCache: false,
    needsElapsed: true,
  };
}
