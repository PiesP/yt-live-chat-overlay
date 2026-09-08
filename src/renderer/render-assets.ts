// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

interface RenderAssetSegment {
  type: 'text' | 'emoji';
  emojiUrl?: string;
  emoji?: { url: string };
}

interface RenderAssetMessage {
  kind?: string;
  authorType?: string;
  author?: string;
  authorPhotoUrl?: string;
  content?: readonly RenderAssetSegment[];
  superChatStickerUrl?: string;
  superChat?: { sticker?: { url: string } };
  cardConfigWorker?: { authorShow: boolean; stickerEnabled: boolean };
}

export interface RequiredRenderAssets {
  emojiUrls: string[];
  authorPhotoUrl?: string;
  stickerUrl?: string;
}

/** Resolve only the image resources that the current renderer will display. */
export function resolveRequiredRenderAssets(
  message: RenderAssetMessage,
  showAuthor: Readonly<Record<string, boolean>>
): RequiredRenderAssets {
  const emojiUrls: string[] = [];
  for (const segment of message.content ?? []) {
    if (segment.type !== 'emoji') continue;
    const url = segment.emojiUrl ?? segment.emoji?.url;
    if (url) emojiUrls.push(url);
  }

  const paidAuthorVisible = message.cardConfigWorker?.authorShow;
  const authorVisible =
    paidAuthorVisible ??
    (message.kind === 'membership'
      ? true
      : message.kind === 'superchat'
        ? (showAuthor.superChat ?? false)
        : (showAuthor[message.authorType ?? 'normal'] ?? false));
  const authorPhotoUrl =
    authorVisible && message.author && message.authorPhotoUrl ? message.authorPhotoUrl : undefined;

  const stickerVisible = message.cardConfigWorker?.stickerEnabled ?? message.kind === 'superchat';
  const rawStickerUrl = message.superChatStickerUrl ?? message.superChat?.sticker?.url;
  const stickerUrl = stickerVisible ? rawStickerUrl : undefined;

  return {
    emojiUrls,
    ...(authorPhotoUrl ? { authorPhotoUrl } : {}),
    ...(stickerUrl ? { stickerUrl } : {}),
  };
}
