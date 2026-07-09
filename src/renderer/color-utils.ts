// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Color utility functions extracted from design-tokens.ts.
 *
 * Color parsing, contrast computation, opacity helpers, and
 * SuperChat color resolution.
 */

import type { RgbColor, SuperChatTier } from '@app-types';

/** Parse any supported color string (hex or rgb/rgba) to RgbColor. */
export function parseAnyColor(colorString: string): RgbColor | null {
  if (colorString.startsWith('#')) {
    const hex = colorString.slice(1);
    if (hex.length < 3) return null;
    if (hex.length === 3) {
      // #RGB → expand each char to two (#RRGGBB)
      const r = parseInt(hex[0]! + hex[0], 16);
      const g = parseInt(hex[1]! + hex[1], 16);
      const b = parseInt(hex[2]! + hex[2], 16);
      return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b } : null;
    }
    if (hex.length === 4) {
      // #RGBA → expand first 3 chars (#RRGGBB), drop alpha (RgbColor has no alpha field)
      const r = parseInt(hex[0]! + hex[0], 16);
      const g = parseInt(hex[1]! + hex[1], 16);
      const b = parseInt(hex[2]! + hex[2], 16);
      return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b } : null;
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b } : null;
  }
  const match = colorString.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/**
 * Relative luminance per WCAG 2.0.
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function relativeLuminance(rgb: RgbColor): number {
  const [rs, gs, bs] = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
  const r = rs <= 0.03928 ? rs / 12.92 : ((rs + 0.055) / 1.055) ** 2.4;
  const g = gs <= 0.03928 ? gs / 12.92 : ((gs + 0.055) / 1.055) ** 2.4;
  const b = bs <= 0.03928 ? bs / 12.92 : ((bs + 0.055) / 1.055) ** 2.4;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Max cached outline color entries before LRU eviction. */
const OUTLINE_COLOR_CACHE_MAX = 64;

/** Cache for computeOutlineColor results — avoids repeated regex + WCAG luminance
 *  calculations for the same text-color/opacity pair across multiple render calls. */
const outlineColorCache = new Map<string, string>();

/** Clear the outline color cache. Used by tests to reset module-level state. */
export function resetOutlineColorCache(): void {
  outlineColorCache.clear();
}

/**
 * Compute an outline color derived from text color with opacity.
 *
 * Uses WCAG 2.0 relative luminance: light text (L > 0.5) gets a dark
 * outline, dark text gets a light outline. This ensures the outline is
 * always visible regardless of the text color or background.
 *
 * Uses a module-level LRU cache (max {@link OUTLINE_COLOR_CACHE_MAX} entries)
 * keyed on `textColor|opacity` to avoid redundant color parsing in the hot
 * render path. This is a transparent performance optimization — the function
 * is semantically pure for identical inputs.
 *
 * @param textColor - CSS color string (hex or rgb/rgba)
 * @param opacity   - Outline opacity (0-1)
 * @returns CSS rgba string for the outline stroke
 */
export function computeOutlineColor(textColor: string, opacity: number): string {
  const cacheKey = `${textColor}|${Math.round(opacity * 100) / 100}`;
  const cached = outlineColorCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const rgb = parseAnyColor(textColor);
  let result: string;
  if (!rgb) {
    result = `rgba(0, 0, 0, ${opacity})`;
  } else {
    const lum = relativeLuminance(rgb);
    result = lum > 0.5 ? `rgba(0, 0, 0, ${opacity})` : `rgba(255, 255, 255, ${opacity})`;
  }

  // LRU eviction: delete oldest entry when at capacity
  if (outlineColorCache.size >= OUTLINE_COLOR_CACHE_MAX) {
    const oldestKey = outlineColorCache.keys().next().value;
    if (oldestKey !== undefined) outlineColorCache.delete(oldestKey);
  }
  outlineColorCache.set(cacheKey, result);
  return result;
}

/**
 * Convert an rgb(...) or rgba(...) color string to rgba(...) with the given alpha.
 */
export function toRgba(color: string, alpha: number): string {
  const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)/);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

/**
 * Choose a readable text color (black or white) for a given background color.
 * Uses WCAG 2.0 relative luminance: returns '#000000' for light backgrounds,
 * '#ffffff' for dark backgrounds.
 */
export function computeReadableTextColor(backgroundColor: string): string {
  const rgb = parseAnyColor(backgroundColor);
  if (!rgb) return '#ffffff';
  return relativeLuminance(rgb) > 0.5 ? '#000000' : '#ffffff';
}

/**
 * Desaturate a CSS color toward gray by a given factor.
 * Accepts #RRGGBB hex, #RGB short hex, or rgb(r,g,b) / rgba(r,g,b,a) formats.
 * factor 0 = original, 1 = full grayscale.
 * Uses luminance-preserving weights (ITU-R BT.601).
 */
export function desaturateColor(color: string, factor: number): string {
  let r: number, g: number, b: number;

  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
      g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
      b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return color;
    const [, rStr = '0', gStr = '0', bStr = '0'] = match;
    r = parseInt(rStr, 10);
    g = parseInt(gStr, 10);
    b = parseInt(bStr, 10);
  }

  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  return `rgb(${Math.round(r + (gray - r) * factor)},${Math.round(g + (gray - g) * factor)},${Math.round(b + (gray - b) * factor)})`;
}

/** Resolve SuperChat display color: use YouTube's color if available, else tier default. */
export function resolveSuperChatRgb(
  superChat: { headerBackgroundColor?: string; backgroundColor?: string; tier: SuperChatTier },
  colors: Record<SuperChatTier, RgbColor>
): RgbColor {
  const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
  const parsed = sourceColor ? parseAnyColor(sourceColor) : null;
  return parsed ?? colors[superChat.tier] ?? colors.blue;
}
