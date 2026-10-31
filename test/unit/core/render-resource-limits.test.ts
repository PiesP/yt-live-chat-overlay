// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  getRenderMessageResourceViolation,
  inspectBoundedRenderText,
  MAX_RENDER_CONTENT_SEGMENTS,
  MAX_RENDER_FIELD_CODE_POINTS,
} from '@chat/render-resource-limits';
import { describe, expect, it } from 'vite-plus/test';

describe('render message resource limits', () => {
  it('counts accepted canonical content for the aggregate without counting display twice', () => {
    const message = {
      text: `${'a'.repeat(79)}…`,
      content: [{ type: 'text', content: `${'a'.repeat(79)}…` }],
      canonicalText: 'a'.repeat(4000),
      canonicalContent: [{ type: 'text', content: 'a'.repeat(4000) }],
      author: 'a'.repeat(96),
    };
    expect(getRenderMessageResourceViolation(message)).toBeNull();
    expect(getRenderMessageResourceViolation({ ...message, author: 'a'.repeat(97) })).toEqual({
      field: 'aggregate',
      reason: 'aggregate-code-points',
    });
    expect(
      getRenderMessageResourceViolation({
        ...message,
        canonicalContent: [{ type: 'text', content: 'a'.repeat(4097) }],
      })
    ).toEqual({ field: 'body', reason: 'code-point-length' });
  });
  it('accepts the exact BMP and astral code-point boundaries', () => {
    expect(inspectBoundedRenderText('a'.repeat(MAX_RENDER_FIELD_CODE_POINTS), 'body')).toEqual({
      codePoints: MAX_RENDER_FIELD_CODE_POINTS,
    });
    expect(inspectBoundedRenderText('😀'.repeat(MAX_RENDER_FIELD_CODE_POINTS), 'body')).toEqual({
      codePoints: MAX_RENDER_FIELD_CODE_POINTS,
    });
  });

  it('rejects one code point above the boundary through both fast paths', () => {
    expect(inspectBoundedRenderText('a'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1), 'body')).toEqual({
      violation: { field: 'body', reason: 'code-point-length' },
    });
    expect(inspectBoundedRenderText('😀'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1), 'body')).toEqual(
      { violation: { field: 'body', reason: 'utf16-length' } }
    );
  });

  it.each(['author', 'translatedText', 'membershipHeader', 'superChatAmount'] as const)(
    'bounds the displayed %s field independently',
    (field) => {
      const exact = 'x'.repeat(MAX_RENDER_FIELD_CODE_POINTS);
      const over = `${exact}x`;
      expect(getRenderMessageResourceViolation({ [field]: exact })).toBeNull();
      expect(getRenderMessageResourceViolation({ [field]: over })).toEqual({
        field: field === 'superChatAmount' ? 'amount' : field,
        reason: 'code-point-length',
      });
    }
  );

  it('bounds the nested paid amount when a direct amount is also present', () => {
    expect(
      getRenderMessageResourceViolation({
        superChatAmount: '$5',
        superChat: { amount: 'x'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1) },
      })
    ).toEqual({ field: 'amount', reason: 'code-point-length' });
    expect(
      getRenderMessageResourceViolation({
        superChat: { amount: 'x'.repeat(MAX_RENDER_FIELD_CODE_POINTS) },
      })
    ).toBeNull();
  });

  it('uses UTF-16 units for the fast boundary and code points for BMP and astral text', () => {
    const exactUtf16 = '😀'.repeat(MAX_RENDER_FIELD_CODE_POINTS);
    expect(exactUtf16.length).toBe(8192);
    expect(inspectBoundedRenderText(exactUtf16, 'translatedText')).toEqual({ codePoints: 4096 });
    expect(inspectBoundedRenderText(`${exactUtf16}a`, 'translatedText')).toEqual({
      violation: { field: 'translatedText', reason: 'utf16-length' },
    });
    expect(inspectBoundedRenderText('a'.repeat(4097), 'translatedText')).toEqual({
      violation: { field: 'translatedText', reason: 'code-point-length' },
    });
    expect(inspectBoundedRenderText(`${'😀'.repeat(4095)}a`, 'translatedText')).toEqual({
      codePoints: 4096,
    });
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

  it('accepts the combined displayed boundary, then rejects an extra translated code point', () => {
    const displayed = {
      text: 'a'.repeat(1000),
      content: [{ type: 'text', content: 'a'.repeat(1000) }],
      author: 'b'.repeat(1000),
      superChatAmount: 'c'.repeat(1000),
      membershipHeader: 'd'.repeat(1000),
      translatedText: 'e'.repeat(96),
    };
    expect(getRenderMessageResourceViolation(displayed)).toBeNull();
    expect(
      getRenderMessageResourceViolation({
        ...displayed,
        translatedText: `${displayed.translatedText}e`,
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
