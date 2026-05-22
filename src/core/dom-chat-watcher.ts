/**
 * DomChatWatcher — watches YouTube's chat DOM for newly rendered messages
 * and forwards them to the overlay's ChatSource as a fallback delivery path.
 *
 * This is a secondary/backup mechanism. The primary path is the fetch
 * interceptor (fetch-interceptor.ts), which eavesdrops on YouTube's own API
 * responses. The DOM watcher catches messages that the fetch interceptor
 * might miss (e.g. if YouTube changes its internal fetch URL pattern), and
 * also works for text messages when the chat panel is open.
 *
 * Only text messages are extracted — SuperChat and Membership messages
 * require structured data (amount, tier, colors) that is not available
 * from DOM text content alone.
 *
 * Zero runtime dependencies — uses MutationObserver and standard DOM APIs.
 */

import type { ChatMessage } from '@app-types';
import { createLogger } from '@core/logging';

const log = createLogger('DomChatWatcher');

/**
 * YouTube chat container selectors.
 * The chat iframe (#chatframe) is cross-origin on some YouTube layouts,
 * so we watch the host-page chat container instead.
 */
const CHAT_CONTAINER_SELECTORS = [
  'yt-live-chat-item-list-renderer #items',
  '#chat-messages yt-live-chat-item-list-renderer #items',
  'yt-live-chat-item-list-renderer',
] as const;

type DomMessageCallback = (messages: ChatMessage[]) => void;

export type DomWatcherUnsubscribe = () => void;

/**
 * Install a MutationObserver that watches YouTube's chat DOM for new messages.
 *
 * @param onMessages Called with parsed ChatMessage[] whenever new chat DOM nodes appear.
 * @returns          Unsubscribe function that disconnects the observer.
 */
export function installDomChatWatcher(onMessages: DomMessageCallback): DomWatcherUnsubscribe {
  let observer: MutationObserver | null = null;

  const extractMessages = (addedNodes: NodeList): ChatMessage[] => {
    const messages: ChatMessage[] = [];
    const now = Date.now();

    for (let i = 0; i < addedNodes.length; i++) {
      const node = addedNodes[i];
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as HTMLElement;

      // Check if this element itself is a text-message renderer
      const textRenderer = el.matches?.('yt-live-chat-text-message-renderer')
        ? el
        : el.querySelector?.('yt-live-chat-text-message-renderer');

      if (!textRenderer) continue;

      const authorEl = textRenderer.querySelector?.('#author-name');
      const messageEl = textRenderer.querySelector?.('#message');

      const author = authorEl?.textContent?.trim() ?? '';
      const text = messageEl?.textContent?.trim() ?? '';

      if (!text) continue;

      const rawId = textRenderer.id;

      const message: ChatMessage = {
        ...(rawId ? { id: rawId } : {}),
        text,
        content: [{ type: 'text', content: text }],
        kind: 'text',
        timestamp: now,
        author,
        authorType: 'normal',
      };

      messages.push(message);
    }

    return messages;
  };

  const handleMutations = (mutations: MutationRecord[]): void => {
    const allMessages: ChatMessage[] = [];

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      if (mutation.addedNodes.length === 0) continue;

      const messages = extractMessages(mutation.addedNodes);
      allMessages.push(...messages);
    }

    if (allMessages.length > 0) {
      log.debug(`DOM watcher captured ${allMessages.length} chat message(s)`);
      onMessages(allMessages);
    }
  };

  // Find the chat container and attach observer.
  for (const selector of CHAT_CONTAINER_SELECTORS) {
    const container = document.querySelector<HTMLElement>(selector);
    if (!container) continue;

    observer = new MutationObserver(handleMutations);
    observer.observe(container, { childList: true, subtree: true });
    log.info(`DOM chat watcher installed on: ${selector}`);
    return () => {
      observer?.disconnect();
      observer = null;
      log.info('DOM chat watcher removed');
    };
  }

  // No container found — return a no-op unsubscribe.
  // The caller can retry later if needed.
  log.debug('No chat container found — DOM watcher not installed');
  return () => {};
}
