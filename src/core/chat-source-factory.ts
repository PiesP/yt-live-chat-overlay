/**
 * ChatSource factory — creates the correct ChatSource subclass.
 *
 * Static imports avoid unnecessary async chunks for a single-file userscript
 * where both concretions are always included in the bundle.
 */

import type { OverlaySettings } from '@app-types';
import type { ChatSource } from '@core/chat-source-base';
import { LiveChatSource } from '@core/chat-source-live';
import { ReplayChatSource } from '@core/chat-source-replay';
import { bootstrapChatSession } from '@core/youtubei-chat';

export async function createChatSource(
  getSettings: () => Readonly<OverlaySettings>,
  signal?: AbortSignal
): Promise<ChatSource> {
  const result = await bootstrapChatSession(signal);
  if (result.status === 'ready' && result.data?.isReplay) {
    return new ReplayChatSource(getSettings);
  }
  return new LiveChatSource(getSettings);
}
