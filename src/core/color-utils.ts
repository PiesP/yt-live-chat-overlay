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
    const expand = hex.length <= 4;
    const h0 = hex[0] ?? '0';
    const h1 = hex[1] ?? '0';
    const h2 = hex[2] ?? '0';
    const r = parseInt(expand ? h0 + h0 : hex.slice(0, 2), 16);
    const g = parseInt(expand ? h1 + h1 : hex.slice(2, 4), 16);
    const b = parseInt(expand ? h2 + h2 : hex.slice(4, 6), 16);
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

/**
 * Compute an outline color that contrasts with the given text color.
 *
 * Uses WCAG 2.0 relative luminance: light text (L > 0.5) gets a dark
 * outline, dark text gets a light outline. This ensures the outline is
 * always visible regardless of the text color or background.
 *
 * @param textColor - CSS color string (hex or rgb/rgba)
 * @param opacity   - Outline opacity (0-1)
 * @returns CSS rgba string for the outline stroke
 */
export function computeOutlineColor(textColor: string, opacity: number): string {
  const rgb = parseAnyColor(textColor);
  if (!rgb) return `rgba(0, 0, 0, ${opacity})`;
  const lum = relativeLuminance(rgb);
  if (lum > 0.5) {
    return `rgba(0, 0, 0, ${opacity})`;
  }
  return `rgba(255, 255, 255, ${opacity})`;
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

/** Resolve SuperChat display color: use YouTube's color if available, else tier default. */
export function resolveSuperChatRgb(
  superChat: { headerBackgroundColor?: string; backgroundColor?: string; tier: SuperChatTier },
  colors: Record<SuperChatTier, RgbColor>
): RgbColor {
  const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
  const parsed = sourceColor ? parseAnyColor(sourceColor) : null;
  return parsed ?? colors[superChat.tier] ?? colors.blue;
}
