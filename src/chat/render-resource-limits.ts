// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { isRecord } from '@piesp/browser-core/util';

/** Wide defensive ceiling above YouTube's normal supported chat lengths. */
export const MAX_RENDER_FIELD_CODE_POINTS = 4096;
/** Fast UTF-16 rejection bound that still permits 4096 astral code points. */
export const MAX_RENDER_FIELD_UTF16_LENGTH = MAX_RENDER_FIELD_CODE_POINTS * 2;
/** Maximum rich text/emoji segments retained for one rendered message. */
export const MAX_RENDER_CONTENT_SEGMENTS = 512;

export type RenderResourceField =
  | 'aggregate'
  | 'amount'
  | 'author'
  | 'body'
  | 'contentSegments'
  | 'membershipHeader'
  | 'translatedText';

export interface RenderResourceViolation {
  readonly field: RenderResourceField;
  readonly reason: 'aggregate-code-points' | 'code-point-length' | 'segment-count' | 'utf16-length';
}

export type BoundedTextInspection =
  | { readonly codePoints: number }
  | { readonly violation: RenderResourceViolation };

/**
 * Count a text field without allocating a code-point array. The UTF-16 check
 * rejects impossible-to-admit input before the bounded scalar-value scan.
 */
export function inspectBoundedRenderText(
  value: string,
  field: RenderResourceField
): BoundedTextInspection {
  if (value.length > MAX_RENDER_FIELD_UTF16_LENGTH) {
    return { violation: { field, reason: 'utf16-length' } };
  }
  let codePoints = 0;
  for (const _codePoint of value) {
    codePoints++;
    if (codePoints > MAX_RENDER_FIELD_CODE_POINTS) {
      return { violation: { field, reason: 'code-point-length' } };
    }
  }
  return { codePoints };
}

function readOptionalString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function inspectField(
  value: string | null,
  field: RenderResourceField
): { codePoints: number; violation?: RenderResourceViolation } {
  if (value === null) return { codePoints: 0 };
  const inspection = inspectBoundedRenderText(value, field);
  return 'violation' in inspection
    ? { codePoints: 0, violation: inspection.violation }
    : { codePoints: inspection.codePoints };
}

function inspectContent(content: readonly unknown[]): {
  codePoints: number;
  violation?: RenderResourceViolation;
} {
  if (content.length > MAX_RENDER_CONTENT_SEGMENTS) {
    return {
      codePoints: 0,
      violation: { field: 'contentSegments', reason: 'segment-count' },
    };
  }

  let codePoints = 0;
  for (const segment of content) {
    if (!isRecord(segment)) continue;
    const nestedEmoji = isRecord(segment.emoji) ? segment.emoji : null;
    const candidates = [
      readOptionalString(segment, 'content'),
      readOptionalString(segment, 'emojiFallbackText'),
      readOptionalString(segment, 'emojiAlt'),
      nestedEmoji ? readOptionalString(nestedEmoji, 'fallbackText') : null,
      nestedEmoji ? readOptionalString(nestedEmoji, 'alt') : null,
    ];
    for (const candidate of candidates) {
      const inspection = inspectField(candidate, 'body');
      if (inspection.violation) return inspection;
    }

    const canonicalText =
      segment.type === 'text'
        ? readOptionalString(segment, 'content')
        : (readOptionalString(segment, 'emojiFallbackText') ??
          (nestedEmoji ? readOptionalString(nestedEmoji, 'fallbackText') : null) ??
          readOptionalString(segment, 'emojiAlt') ??
          (nestedEmoji ? readOptionalString(nestedEmoji, 'alt') : null) ??
          readOptionalString(segment, 'content'));
    const canonical = inspectField(canonicalText, 'body');
    if (canonical.violation) return canonical;
    codePoints += canonical.codePoints;
    if (codePoints > MAX_RENDER_FIELD_CODE_POINTS) {
      return {
        codePoints: 0,
        violation: { field: 'body', reason: 'code-point-length' },
      };
    }
  }
  return { codePoints };
}

/**
 * Validate the distinct strings that one main-thread or Worker renderer can
 * display. `text` and `content` are alternate body representations, so only
 * the rich content projection contributes to the aggregate when it exists.
 */
export function getRenderMessageResourceViolation(value: unknown): RenderResourceViolation | null {
  if (!isRecord(value)) return null;

  const text = inspectField(readOptionalString(value, 'text'), 'body');
  if (text.violation) return text.violation;

  let bodyCodePoints = text.codePoints;
  if (Array.isArray(value.content)) {
    const content = inspectContent(value.content);
    if (content.violation) return content.violation;
    if (value.content.length > 0) bodyCodePoints = content.codePoints;
  }

  const author = inspectField(readOptionalString(value, 'author'), 'author');
  if (author.violation) return author.violation;
  const translated = inspectField(readOptionalString(value, 'translatedText'), 'translatedText');
  if (translated.violation) return translated.violation;
  const membershipHeader = inspectField(
    readOptionalString(value, 'membershipHeader'),
    'membershipHeader'
  );
  if (membershipHeader.violation) return membershipHeader.violation;

  const nestedSuperChat = isRecord(value.superChat) ? value.superChat : null;
  const directAmount = readOptionalString(value, 'superChatAmount');
  const nestedAmount = nestedSuperChat ? readOptionalString(nestedSuperChat, 'amount') : null;
  for (const amountValue of [directAmount, nestedAmount]) {
    const amount = inspectField(amountValue, 'amount');
    if (amount.violation) return amount.violation;
  }
  const amount = inspectField(directAmount ?? nestedAmount, 'amount');

  const aggregateCodePoints =
    bodyCodePoints +
    author.codePoints +
    translated.codePoints +
    membershipHeader.codePoints +
    amount.codePoints;
  return aggregateCodePoints > MAX_RENDER_FIELD_CODE_POINTS
    ? { field: 'aggregate', reason: 'aggregate-code-points' }
    : null;
}
