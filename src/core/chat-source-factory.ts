/**
 * ChatSource factory — creates the correct ChatSource subclass.
 *
 * Separated from chat-source.ts to avoid circular dependencies between
 * the abstract base and its concrete implementations.
 */

import type { OverlaySettings } from '@app-types';
import type { ChatSource } from '@core/chat-source-base';
import { bootstrapChatSession } from '@core/youtubei-chat';

export async function createChatSource(
  getSettings: () => Readonly<OverlaySettings>,
  signal?: AbortSignal
): Promise<ChatSource> {
  const result = await bootstrapChatSession(signal);
  if (result.status === 'ready' && result.data?.isReplay) {
    const { ReplayChatSource } = await import('@core/chat-source-replay');
    return new ReplayChatSource(getSettings);
  }
  const { LiveChatSource } = await import('@core/chat-source-live');
  return new LiveChatSource(getSettings);
}
