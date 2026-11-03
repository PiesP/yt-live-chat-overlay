// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Color utility functions extracted from design-tokens.ts.
 *
 * Color parsing, contrast computation, opacity helpers, and
 * SuperChat color resolution.
 */

import type { RgbColor, SuperChatTier } from '@app-types';
import { FAR_LAYER_DESATURATION_FACTOR } from '@renderer/constants';

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The persisted color grammar: #RGB, #RGBA, #RRGGBB, or #RRGGBBAA. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

interface ParsedColor {
  rgb: RgbColor;
  alpha?: number;
}

function parseColor(color: string): ParsedColor | null {
  if (color.startsWith('#')) {
    if (!isHexColor(color)) return null;
    const hex = color.slice(1);
    const short = hex.length <= 4;
    const channel = (index: number): number =>
      short
        ? parseInt(hex.charAt(index) + hex.charAt(index), 16)
        : parseInt(hex.slice(index, index + 2), 16);
    const rgb = short
      ? { r: channel(0), g: channel(1), b: channel(2) }
      : { r: channel(0), g: channel(2), b: channel(4) };
    const alpha =
      hex.length === 4 ? channel(3) / 255 : hex.length === 8 ? channel(6) / 255 : undefined;
    return alpha === undefined ? { rgb } : { rgb, alpha };
  }
  const match =
    /^(?:rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)|rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\))$/i.exec(
      color
    );
  if (!match) return null;
  const rgb = {
    r: Number(match[1] ?? match[4]),
    g: Number(match[2] ?? match[5]),
    b: Number(match[3] ?? match[6]),
  };
  if (Object.values(rgb).some((value) => value > 255)) return null;
  const alpha = match[7] === undefined ? undefined : Number(match[7]);
  return alpha === undefined ? { rgb } : { rgb, alpha };
}

/** Parse any supported color string (hex or rgb/rgba) to RgbColor. */
export function parseAnyColor(colorString: string): RgbColor | null {
  return parseColor(colorString)?.rgb ?? null;
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
 * Compare black and white contrast against the supplied RGB background.
 * Translucent card compositing over video needs a separate assessment.
 */
export function computeReadableTextColor(backgroundColor: string): string {
  const rgb = parseAnyColor(backgroundColor);
  if (!rgb) return '#ffffff';
  const luminance = relativeLuminance(rgb);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}

/**
 * Desaturate a CSS color toward gray by a given factor.
 * Accepts the persisted hex grammar or rgb(r,g,b) / rgba(r,g,b,a).
 * factor 0 = original, 1 = full grayscale.
 * Uses luminance-preserving weights (ITU-R BT.601).
 */
export function desaturateColor(color: string, factor: number): string {
  const parsed = parseColor(color);
  if (!parsed || !Number.isFinite(factor)) return color;
  const { r, g, b } = parsed.rgb;
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const channels = `${Math.round(r + (gray - r) * factor)},${Math.round(g + (gray - g) * factor)},${Math.round(b + (gray - b) * factor)}`;
  return parsed.alpha === undefined ? `rgb(${channels})` : `rgba(${channels},${parsed.alpha})`;
}

/** Resolve the regular message color once, then apply the same FAR rule on both renderers. */
export function resolveRegularMessageColor(
  userColor: string | undefined,
  preserveUserColor: boolean,
  authorColor: string | undefined,
  fallbackColor: string,
  far: boolean
): string {
  const selected = (preserveUserColor && userColor) || authorColor || fallbackColor;
  return far ? desaturateColor(selected, FAR_LAYER_DESATURATION_FACTOR) : selected;
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
