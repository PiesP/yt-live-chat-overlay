// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CardConfig — unified card configuration for SuperChat and Membership messages.
 *
 * Defines card appearance, behavior, and rendering hints. Factory functions
 * create complete configs using design-tokens and color-utils constants.
 */

import type { ChatMessage, OverlaySettings, RgbColor } from '@app-types';
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
