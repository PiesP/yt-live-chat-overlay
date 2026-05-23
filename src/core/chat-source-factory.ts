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
import type { ChatBootstrapResult } from '@core/youtubei-chat';
import { bootstrapChatSession } from '@core/youtubei-chat';

export async function createChatSource(
  getSettings: () => Readonly<OverlaySettings>,
  signal?: AbortSignal
): Promise<{ chatSource: ChatSource; bootstrapResult: ChatBootstrapResult }> {
  const result = await bootstrapChatSession(signal);
  const chatSource =
    result.status === 'ready' && result.data?.isReplay
      ? new ReplayChatSource(getSettings)
      : new LiveChatSource(getSettings);

  return { chatSource, bootstrapResult: result };
}

/**
 * Seed a ChatSource with pre-resolved bootstrap data from the factory call.
 * This avoids a duplicate ~200KB watch page HTTP request in bootstrapAndLaunchPolling.
 */
export function seedBootstrapIfReady(chatSource: ChatSource, result: ChatBootstrapResult): void {
  if (result.status === 'ready') {
    chatSource.setInitialBootstrap(result.data);
  }
}
