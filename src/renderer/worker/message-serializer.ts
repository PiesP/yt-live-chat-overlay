// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import {
  MEMBERSHIP_CARD_CONFIG,
  SUPERCHAT_CARD_CONFIG,
  toWorkerConfig,
} from '@renderer/card-config';
import type { WorkerContentSegment, WorkerMessage } from './types';

export interface SerializeWorkerMessageInput {
  message: ChatMessage;
  id: string;
  dimensions: { width: number; height: number };
  priority: number;
  burstSpeedMultiplier: number;
  settings: OverlaySettings;
}

/** Project an ingress chat message into the serializable Worker protocol shape. */
export function serializeWorkerMessage({
  message,
  id,
  dimensions,
  priority,
  burstSpeedMultiplier,
  settings,
}: SerializeWorkerMessageInput): WorkerMessage {
  const content: WorkerContentSegment[] = message.content.map((segment) => {
    if (segment.type === 'text') {
      return { type: 'text', content: segment.content };
    }
    return {
      type: 'emoji',
      content: segment.emoji.alt,
      emojiUrl: segment.emoji.url,
      emojiAlt: segment.emoji.alt,
      ...(segment.emoji.fallbackText !== undefined
        ? { emojiFallbackText: segment.emoji.fallbackText }
        : {}),
    };
  });
  const translatedText = (message as ChatMessage & { translatedText?: string }).translatedText;

  return {
    id,
    text: message.text,
    width: dimensions.width,
    height: dimensions.height,
    priority,
    isBacklog: message.isBacklog ?? false,
    authorType: message.authorType,
    kind: message.kind,
    userColor: message.userColor,
    cardConfigWorker:
      message.kind === 'superchat' || message.kind === 'membership'
        ? toWorkerConfig(
            message.kind === 'superchat' ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG,
            message,
            settings
          )
        : undefined,
    burstSpeedMultiplier,
    ...(translatedText !== undefined ? { translatedText } : {}),
    content,
    author: message.author,
    authorPhotoUrl: message.authorPhotoUrl,
    ...(message.kind === 'superchat' && message.superChat
      ? {
          superChatAmount: message.superChat.amount,
          superChatStickerUrl: message.superChat.sticker?.url,
        }
      : {}),
    ...(message.kind === 'membership' ? { membershipHeader: message.membershipHeader } : {}),
  } as WorkerMessage;
}
