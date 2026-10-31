// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { accessiblePresentationText, isPresentableFrame } from '@renderer/presentation';
import { describe, expect, it } from 'vite-plus/test';

describe('presentation eligibility', () => {
  it('requires a started, unexpired, intersecting frame with positive quantized alpha', () => {
    const eligible = (
      overrides: Partial<{
        elapsed: number;
        x: number;
        y: number;
        bucket: number;
        hidden: boolean;
      }> = {}
    ) =>
      isPresentableFrame(
        overrides.elapsed ?? 500,
        1_000,
        overrides.x ?? 20,
        overrides.y ?? 30,
        100,
        20,
        640,
        360,
        overrides.bucket ?? 1,
        overrides.hidden ?? false
      );

    expect(eligible()).toBe(true);
    expect(eligible({ elapsed: -1 })).toBe(false);
    expect(eligible({ elapsed: 1_000 })).toBe(false);
    expect(eligible({ x: 640 })).toBe(false);
    expect(eligible({ x: -100 })).toBe(false);
    expect(eligible({ y: 360 })).toBe(false);
    expect(eligible({ y: -20 })).toBe(false);
    expect(eligible({ bucket: 0 })).toBe(false);
    expect(eligible({ hidden: true })).toBe(false);
    expect(isPresentableFrame(500, 1_000, -20, 20, 100, 20, 0, 360, 1, false)).toBe(false);
  });

  it('uses the canonical original and only the translation visible in each mode', () => {
    expect(accessiblePresentationText('full original', 'translation', true, 'dual')).toBe(
      'full original — translation'
    );
    expect(accessiblePresentationText('full original', 'translation', true, 'replace')).toBe(
      'translation'
    );
    expect(accessiblePresentationText('full original', null, true, 'replace')).toBe(
      'full original'
    );
    expect(accessiblePresentationText('full original', 'translation', false, 'dual')).toBe(
      'full original'
    );
  });
});
