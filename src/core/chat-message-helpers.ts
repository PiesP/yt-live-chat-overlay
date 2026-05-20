/**
 * Shared helpers for YouTube chat message parsing.
 *
 * Extracted from chat-message-parser.ts to keep the parser focused on
 * message extraction logic and to make these pure utilities independently
 * testable and reusable.
 */

import type { ContentSegment, SuperChatInfo } from '@app-types';
import { colors, parseAnyColor, SUPERCHAT_TIER_KEYS } from '@core/design-tokens';
import type { JsonObject } from '@core/youtubei-chat';

/**
 * Matches any character with the Emoji Unicode property.
 *
 * Uses \p{Emoji} instead of \p{Extended_Pictographic} so that compound
 * emoji sequences (skin-tone variants, ZWJ sequences, keycap sequences)
 * are also detected.
 */
export const EMOJI_TEXT_PATTERN = /\p{Emoji}/u;
export const EMOJI_ALIAS_PATTERN = /^:[^:\\s][^:]*:$/u;

export function stripControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

export function normalizeInlineText(text: string): string {
  return stripControlCharacters(text).replace(/\s+/g, ' ').trim();
}

/** Maximum allowed message text length before truncation. */
export const MAX_MESSAGE_TEXT_LENGTH = 80;

/** Length of the ellipsis appended to truncated text. */
export const TRUNCATION_ELLIPSIS_LENGTH = 3;

export function truncateText(text: string): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length > MAX_MESSAGE_TEXT_LENGTH) {
    return `${normalized.slice(0, MAX_MESSAGE_TEXT_LENGTH - TRUNCATION_ELLIPSIS_LENGTH)}...`;
  }
  return normalized;
}

export function hasEmojiContent(segments: readonly ContentSegment[]): boolean {
  return segments.some(
    (segment) =>
      segment.type === 'emoji' ||
      (segment.type === 'text' && EMOJI_TEXT_PATTERN.test(segment.content))
  );
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

  if (alpha >= 0.999) {
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
    if (r > 240 && g > 240 && b > 240) return undefined;
    if (r < 15 && g < 15 && b < 15) return undefined;
  }

  return cssColor;
}
