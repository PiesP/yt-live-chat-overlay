// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ChatEmojiParser — emoji and image asset parsing from YouTube chat data.
 *
 * Extracted from chat-message-parser.ts to separate emoji/image concerns
 * from the main message extraction logic.
 */

import type { ImageAsset } from '@app-types';
import {
  EMOJI_ALIAS_PATTERN,
  extractAccessibilityLabel,
  normalizeInlineText,
} from '@chat/message-helpers';
import type { JsonObject } from '@chat/youtube/request';
import { getNumber, getString, isRecord } from '@chat/youtube/request';
import { normalizeYouTubeImageUrl } from '@core/image-url-validation';

// ── Image URL validation ─────────────────────────────────────────────────────

// normalizeYouTubeImageUrl is imported from @core/image-url-validation

// ── Thumbnail extraction ─────────────────────────────────────────────────────

interface ThumbnailCandidate {
  url: string;
  candidateUrl?: string;
  width?: number;
  height?: number;
}

export function extractBestThumbnail(value: unknown): ThumbnailCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  const thumbnails = Array.isArray(value.thumbnails)
    ? value.thumbnails
    : Array.isArray(value.sources)
      ? value.sources
      : [];

  const candidates: ThumbnailCandidate[] = [];
  const seenUrls = new Set<string>();

  for (const candidate of thumbnails) {
    if (!isRecord(candidate)) {
      continue;
    }

    const url = getString(candidate.url);
    const normalizedUrl = url ? normalizeYouTubeImageUrl(url) : null;
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    const width = getNumber(candidate.width);
    const nextThumbnail: ThumbnailCandidate = {
      url: normalizedUrl,
    };
    if (width !== undefined) {
      nextThumbnail.width = width;
    }

    const height = getNumber(candidate.height);
    if (height !== undefined) {
      nextThumbnail.height = height;
    }

    candidates.push(nextThumbnail);
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const best = candidates[0];
  if (!best) return null;

  if (candidates.length > 1) {
    const fallback = candidates[1];
    if (fallback) best.candidateUrl = fallback.url;
  }

  return best;
}

// ── Image asset creation ─────────────────────────────────────────────────────

export function createImageAsset(
  value: unknown,
  alt: string,
  fallbackText?: string
): ImageAsset | null {
  const thumbnail = extractBestThumbnail(value);
  if (!thumbnail) {
    return null;
  }

  const asset: ImageAsset = {
    url: thumbnail.url,
    alt,
  };

  if (thumbnail.candidateUrl) {
    asset.candidateUrl = thumbnail.candidateUrl;
  }

  if (fallbackText && fallbackText.length > 0) {
    asset.fallbackText = fallbackText;
  }

  if (thumbnail.width !== undefined) {
    asset.width = thumbnail.width;
  }

  if (thumbnail.height !== undefined) {
    asset.height = thumbnail.height;
  }

  return asset;
}

// ── Emoji parsing ────────────────────────────────────────────────────────────

function getEmojiShortcuts(emojiData: JsonObject): string[] {
  return Array.isArray(emojiData.shortcuts)
    ? emojiData.shortcuts.filter((shortcut): shortcut is string => typeof shortcut === 'string')
    : [];
}

function getEmojiAltText(emojiData: JsonObject): string {
  const shortcuts = getEmojiShortcuts(emojiData);

  return (
    shortcuts[0] ??
    extractAccessibilityLabel(emojiData.image) ??
    extractAccessibilityLabel(emojiData) ??
    getString(emojiData.emojiId) ??
    ''
  );
}

export function getEmojiVisibleFallbackText(emojiData: JsonObject): string {
  const shortcuts = getEmojiShortcuts(emojiData);
  const aliasPattern = EMOJI_ALIAS_PATTERN;
  const nonAliasShortcut = shortcuts.find((s) => !aliasPattern.test(s));
  if (nonAliasShortcut) return normalizeInlineText(nonAliasShortcut);

  const label = extractAccessibilityLabel(emojiData.image) ?? extractAccessibilityLabel(emojiData);
  if (label && !aliasPattern.test(label)) {
    return normalizeInlineText(label);
  }

  return '';
}

export function parseEmoji(emojiData: JsonObject): ImageAsset | null {
  const emojiAsset = createImageAsset(
    emojiData.image,
    getEmojiAltText(emojiData),
    getEmojiVisibleFallbackText(emojiData)
  );
  if (!emojiAsset) {
    return null;
  }

  return emojiAsset;
}
