// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Bound tiny decoded emoji entries even when their byte cost is negligible. */
export const EMOJI_CACHE_MAX_ENTRIES = 500;

/** YouTube stickers commonly decode to 512x512 RGBA (exactly 1 MiB). */
const STANDARD_STICKER_DECODED_BYTES = 512 * 512 * 4;

export function getStickerCacheBytes(configuredMb: number): number {
  return Math.max(configuredMb * 1_000_000, STANDARD_STICKER_DECODED_BYTES);
}
