// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { serializeWorkerMessage } from '@renderer/worker/message-serializer';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { describe, expect, it } from 'vitest';

const dimensions = { width: 320, height: 72 };
const settings = DEFAULT_SETTINGS as OverlaySettings;

function textMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    text: 'hello',
    content: [{ type: 'text', content: 'hello' }],
    kind: 'text',
    timestamp: 1,
    author: 'PiesP',
    authorType: 'normal',
    ...overrides,
  };
}

describe('serializeWorkerMessage', () => {
  it.each([
    {
      label: 'regular text',
      message: textMessage({ isBacklog: true, userColor: '#abcdef' }),
      expected: {
        text: 'hello',
        content: [{ type: 'text', content: 'hello' }],
        isBacklog: true,
        kind: 'text',
        userColor: '#abcdef',
      },
    },
    {
      label: 'emoji content',
      message: textMessage({
        text: 'hi :wave:',
        content: [
          { type: 'text', content: 'hi ' },
          {
            type: 'emoji',
            emoji: {
              url: 'https://yt3.ggpht.com/wave.png',
              alt: ':wave:',
              fallbackText: '👋',
            },
          },
        ],
      }),
      expected: {
        text: 'hi :wave:',
        content: [
          { type: 'text', content: 'hi ' },
          {
            type: 'emoji',
            content: ':wave:',
            emojiUrl: 'https://yt3.ggpht.com/wave.png',
            emojiAlt: ':wave:',
            emojiFallbackText: '👋',
          },
        ],
      },
    },
    {
      label: 'Super Chat card',
      message: textMessage({
        kind: 'superchat',
        superChat: {
          amount: '$5.00',
          tier: 'green',
          sticker: { url: 'https://yt3.ggpht.com/sticker.png', alt: 'sticker' },
        },
      }),
      expected: {
        kind: 'superchat',
        superChatAmount: '$5.00',
        superChatStickerUrl: 'https://yt3.ggpht.com/sticker.png',
        cardConfigWorker: expect.objectContaining({
          badgeEnabled: true,
          showBadgeAmount: settings.showSuperChatAmount,
        }),
      },
    },
    {
      label: 'membership card',
      message: textMessage({ kind: 'membership', membershipHeader: 'Member for 6 months' }),
      expected: {
        kind: 'membership',
        membershipHeader: 'Member for 6 months',
        cardConfigWorker: expect.objectContaining({
          headerTagEnabled: true,
          bodyMaxLines: settings.membershipMaxBodyLines,
        }),
      },
    },
  ])('maps $label protocol fields without mutating the source', ({ message, expected }) => {
    const sourceSnapshot = structuredClone(message);
    const input = {
      message,
      id: 'resolved-id',
      dimensions,
      priority: 80,
      burstSpeedMultiplier: 1.25,
      settings,
    };

    const first = serializeWorkerMessage(input);
    const second = serializeWorkerMessage(input);

    expect(first).toMatchObject({
      id: 'resolved-id',
      width: 320,
      height: 72,
      priority: 80,
      burstSpeedMultiplier: 1.25,
      author: 'PiesP',
      authorType: 'normal',
      ...expected,
    });
    expect(second).toEqual(first);
    expect(message).toEqual(sourceSnapshot);
  });

  it('projects an optional translated result without reading manager state', () => {
    const message = textMessage() as ChatMessage & { translatedText?: string };
    message.translatedText = '안녕하세요';

    expect(
      serializeWorkerMessage({
        message,
        id: 'translated-id',
        dimensions,
        priority: 0,
        burstSpeedMultiplier: 1,
        settings,
      }).translatedText
    ).toBe('안녕하세요');
  });
});
