// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared helpers for YouTube chat message parsing.
 *
 * Extracted from chat-message-parser.ts to keep the parser focused on
 * message extraction logic and to make these pure utilities independently
 * testable and reusable.
 */

import type { AuthorType, ChatMessage, ContentSegment, SuperChatInfo } from '@app-types';
import type { JsonObject } from '@chat/youtube/request';
import { asRecord, getString } from '@chat/youtube/request';
import { parseAnyColor } from '@renderer/color-utils';
import { colors, SUPERCHAT_TIER_KEYS } from '@util/design-tokens';

export const AUTHOR_TYPE_PRIORITY: Record<AuthorType, number> = {
  normal: 0,
  verified: 1,
  member: 2,
  moderator: 3,
  owner: 4,
};

/**
 * Matches any character with the Emoji Unicode property.
 *
 * Uses \p{Emoji} instead of \p{Extended_Pictographic} so that compound
 * emoji sequences (skin-tone variants, ZWJ sequences, keycap sequences)
 * are also detected.
 */
export const EMOJI_TEXT_PATTERN = /\p{Emoji}/u;
export const EMOJI_ALIAS_PATTERN = /^:[^:\s][^:]*:$/u;

/** Strip ASCII control characters (U+0000–U+001F, U+007F–U+009F) from text. */
export function stripControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

/** Collapse whitespace, strip trailing YouTube truncation ellipsis, and trim. */
export function normalizeInlineText(text: string): string {
  return stripControlCharacters(text)
    .replace(/[\u2026]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Maximum allowed message text length before truncation. */
const MAX_MESSAGE_TEXT_LENGTH = 80;

/** Length of the truncation ellipsis placeholder (U+2026 = 1 code unit). */
const TRUNCATION_ELLIPSIS_LENGTH = 1;

/** Fully opaque alpha threshold for CSS color conversion. */
const FULLY_OPAQUE_THRESHOLD = 0.999;

/** Near-white color component threshold (each channel exceeds this). */
const NEAR_WHITE_THRESHOLD = 240;

/** Near-black color component threshold (each channel is below this). */
const NEAR_BLACK_THRESHOLD = 15;

function truncateText(text: string): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length > MAX_MESSAGE_TEXT_LENGTH) {
    return `${normalized.slice(0, MAX_MESSAGE_TEXT_LENGTH - TRUNCATION_ELLIPSIS_LENGTH)}\u2026`;
  }
  return normalized;
}

/**
 * Truncate text based on message kind.
 * Only regular text messages are truncated to MAX_MESSAGE_TEXT_LENGTH.
 * SuperChat and membership messages preserve their full text — the renderer
 * already limits visible lines via `maxBodyLines` with ellipsis.
 */
export function truncateForKind(text: string, kind: ChatMessage['kind']): string {
  if (kind === 'text') return truncateText(text);
  return normalizeInlineText(text);
}

/** Check whether any content segment contains emoji text or imagery. */
export function hasEmojiContent(segments: readonly ContentSegment[]): boolean {
  return segments.some(
    (segment) =>
      segment.type === 'emoji' ||
      (segment.type === 'text' && EMOJI_TEXT_PATTERN.test(segment.content))
  );
}

/**
 * Extract translatable plain text from a message by joining only the text
 * content segments. Emoji segments are excluded because they carry
 * YouTube-supplied fallback text (e.g. :smile:, :웃는 얼굴:) that should
 * not be sent to the translation API — those descriptions would appear
 * as literal text in the translated output.
 */
export function getTranslatableText(message: ChatMessage): string {
  let result = '';
  for (const seg of message.content) {
    if (seg.type === 'text' && seg.content.length > 0) {
      result += seg.content;
    }
  }
  return result.trim();
}

/**
 * Convert a YouTube ARGB 32-bit integer color to a CSS color string.
 */
export function colorIntToCss(value: unknown): string | undefined {
  const intValue = parseColorInt(value);
  if (intValue === undefined) return undefined;

  const argb = intValue >>> 0;
  const alpha = ((argb >>> 24) & 0xff) / 255;
  const red = (argb >>> 16) & 0xff;
  const green = (argb >>> 8) & 0xff;
  const blue = argb & 0xff;

  if (alpha >= FULLY_OPAQUE_THRESHOLD) {
    return `rgb(${red}, ${green}, ${blue})`;
  }
  return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`;
}

function parseColorInt(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Determine the Super Chat tier from a background color string
 * by finding the closest matching tier color (Euclidean distance in RGB).
 */
export function determineSuperChatTier(backgroundColor: string | undefined): SuperChatInfo['tier'] {
  const rgb = backgroundColor ? parseAnyColor(backgroundColor) : null;
  if (!rgb) return 'blue';

  let bestTier: SuperChatInfo['tier'] = 'blue';
  let bestSquaredDistance = Number.POSITIVE_INFINITY;

  for (const tier of SUPERCHAT_TIER_KEYS) {
    const tierColor = colors.superChat[tier];
    const dr = rgb.r - tierColor.r;
    const dg = rgb.g - tierColor.g;
    const db = rgb.b - tierColor.b;
    const squaredDistance = dr * dr + dg * dg + db * db;

    if (squaredDistance < bestSquaredDistance) {
      bestSquaredDistance = squaredDistance;
      bestTier = tier;
    }
  }

  return bestTier;
}

/**
 * Extract the user's self-chosen text color from YouTube's renderer data.
 * YouTube stores this as an ARGB 32-bit integer in `authorNameTextColor`.
 *
 * Returns undefined for colors too close to white (YouTube default) or black.
 */
export function extractUserColor(renderer: JsonObject): string | undefined {
  const colorInt = parseColorInt(renderer.authorNameTextColor);
  if (colorInt === undefined) return undefined;

  const cssColor = colorIntToCss(colorInt);
  if (!cssColor) return undefined;

  const rgbaMatch = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1] ?? '0', 10);
    const g = parseInt(rgbaMatch[2] ?? '0', 10);
    const b = parseInt(rgbaMatch[3] ?? '0', 10);
    // Skip colors too close to white (YouTube default) or black
    if (r > NEAR_WHITE_THRESHOLD && g > NEAR_WHITE_THRESHOLD && b > NEAR_WHITE_THRESHOLD)
      return undefined;
    if (r < NEAR_BLACK_THRESHOLD && g < NEAR_BLACK_THRESHOLD && b < NEAR_BLACK_THRESHOLD)
      return undefined;
  }

  return cssColor;
}

export function extractAccessibilityLabel(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return getString(asRecord(asRecord(record.accessibility)?.accessibilityData)?.label);
}
