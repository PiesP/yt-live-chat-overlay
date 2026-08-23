// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Bound tiny decoded emoji entries even when their byte cost is negligible. */
export const EMOJI_CACHE_MAX_ENTRIES = 500;

/** YouTube stickers commonly decode to 512x512 RGBA (exactly 1 MiB). */
const STANDARD_STICKER_DECODED_BYTES = 512 * 512 * 4;
/** Reserve key accounting for an ordinary CDN URL without accepting unbounded keys. */
const STANDARD_IMAGE_URL_CODE_UNIT_BUDGET = 8_192;
const UTF16_CODE_UNIT_BYTES = 2;

export function getStickerCacheBytes(configuredMb: number): number {
  const standardStickerEntryBytes =
    STANDARD_STICKER_DECODED_BYTES + STANDARD_IMAGE_URL_CODE_UNIT_BUDGET * UTF16_CODE_UNIT_BYTES;
  return Math.max(configuredMb * 1_000_000, standardStickerEntryBytes);
}
