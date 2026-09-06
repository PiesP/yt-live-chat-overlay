// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import {
  getRenderMessageResourceViolation,
  inspectBoundedRenderText,
  MAX_RENDER_CONTENT_SEGMENTS,
  MAX_RENDER_FIELD_CODE_POINTS,
} from '@chat/render-resource-limits';

describe('render message resource limits', () => {
  it('accepts the exact BMP and astral code-point boundaries', () => {
    expect(inspectBoundedRenderText('a'.repeat(MAX_RENDER_FIELD_CODE_POINTS), 'body')).toEqual({
      codePoints: MAX_RENDER_FIELD_CODE_POINTS,
    });
    expect(inspectBoundedRenderText('😀'.repeat(MAX_RENDER_FIELD_CODE_POINTS), 'body')).toEqual({
      codePoints: MAX_RENDER_FIELD_CODE_POINTS,
    });
  });

  it('rejects one code point above the boundary through both fast paths', () => {
    expect(
      inspectBoundedRenderText('a'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1), 'body')
    ).toEqual({ violation: { field: 'body', reason: 'code-point-length' } });
    expect(
      inspectBoundedRenderText('😀'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1), 'body')
    ).toEqual({ violation: { field: 'body', reason: 'utf16-length' } });
  });

  it('counts rich content instead of double-counting its derived plain text', () => {
    const body = 'a'.repeat(MAX_RENDER_FIELD_CODE_POINTS);
    expect(
      getRenderMessageResourceViolation({
        text: body,
        content: [{ type: 'text', content: body }],
      })
    ).toBeNull();
  });

  it('rejects an aggregate overage across distinct displayed fields', () => {
    expect(
      getRenderMessageResourceViolation({
        text: 'a'.repeat(3000),
        content: [{ type: 'text', content: 'a'.repeat(3000) }],
        author: 'b'.repeat(1097),
      })
    ).toEqual({ field: 'aggregate', reason: 'aggregate-code-points' });
  });

  it('accepts exactly 512 segments and rejects the next segment', () => {
    const segment = { type: 'emoji', content: '', emojiAlt: ':x:' };
    expect(
      getRenderMessageResourceViolation({
        text: '',
        content: Array.from({ length: MAX_RENDER_CONTENT_SEGMENTS }, () => segment),
      })
    ).toBeNull();
    expect(
      getRenderMessageResourceViolation({
        text: '',
        content: Array.from({ length: MAX_RENDER_CONTENT_SEGMENTS + 1 }, () => segment),
      })
    ).toEqual({ field: 'contentSegments', reason: 'segment-count' });
  });
});
