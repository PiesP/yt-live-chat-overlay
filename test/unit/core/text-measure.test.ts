// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import { getFontString } from '@renderer/text-measure';
import { DEFAULT_FONT_FAMILY } from '@util/design-tokens';

describe('getFontString', () => {
  const defaultFamily = DEFAULT_FONT_FAMILY;

  it('builds CSS font string with bold weight', () => {
    const result = getFontString(16, 'bold');
    expect(result).toBe(`bold 16px ${defaultFamily}`);
  });

  it('builds CSS font string with normal weight (maps to 400)', () => {
    const result = getFontString(14, 'normal');
    expect(result).toBe(`400 14px ${defaultFamily}`);
  });

  it('accepts a custom font family', () => {
    const result = getFontString(20, 'bold', 'Arial');
    expect(result).toBe('bold 20px Arial');
  });

  it('uses DEFAULT_FONT_FAMILY when no family is provided', () => {
    const result = getFontString(12, 'bold');
    expect(result).toBe(`bold 12px ${defaultFamily}`);
  });

  it('defaults weight to bold when no weight is provided', () => {
    const result = getFontString(18);
    expect(result).toBe(`bold 18px ${defaultFamily}`);
  });

  it('handles fractional pixel size', () => {
    const result = getFontString(13.5, 'normal');
    expect(result).toBe(`400 13.5px ${defaultFamily}`);
  });

  it('builds string with spaces between weight, size, and family', () => {
    const result = getFontString(24, 'bold', '"Inter", sans-serif');
    expect(result).toBe('bold 24px "Inter", sans-serif');
  });
});
