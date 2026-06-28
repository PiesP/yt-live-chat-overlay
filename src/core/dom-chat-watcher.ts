// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

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

const TEXT_MESSAGE_RENDERER_SELECTOR = 'yt-live-chat-text-message-renderer';
const AUTHOR_NAME_SELECTOR = '#author-name';
const MESSAGE_SELECTOR = '#message';

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
  let mutationBatchPending = false;
  let mutationRafId: number | null = null;
  let pendingMutations: MutationRecord[][] = [];
  let isPaused = false;

  const extractMessages = (addedNodes: NodeList): ChatMessage[] => {
    const messages: ChatMessage[] = [];
    const now = Date.now();

    for (let i = 0; i < addedNodes.length; i++) {
      const node = addedNodes[i];
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as HTMLElement;

      // Check if this element itself is a text-message renderer
      const textRenderer = el.matches(TEXT_MESSAGE_RENDERER_SELECTOR)
        ? el
        : el.querySelector(TEXT_MESSAGE_RENDERER_SELECTOR);

      if (!textRenderer) continue;

      const authorEl = textRenderer.querySelector(AUTHOR_NAME_SELECTOR);
      const messageEl = textRenderer.querySelector(MESSAGE_SELECTOR);

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

  /**
   * RAF-batched mutation callback.
   * Multiple MutationObserver callbacks within the same animation frame
   * are coalesced into a single handleMutations call, reducing redundant
   * DOM queries during chat bursts.
   *
   * When the tab is hidden, mutations are dropped entirely to avoid
   * unbounded pendingMutations growth — the observer is paused and
   * re-attached on visibility return.
   */
  const onMutation = (mutations: MutationRecord[]): void => {
    if (isPaused) return;
    pendingMutations.push(mutations);
    if (!mutationBatchPending) {
      mutationBatchPending = true;
      mutationRafId = requestAnimationFrame(() => {
        mutationBatchPending = false;
        mutationRafId = null;
        // Iterate pendingMutations directly instead of flat() — avoids
        // allocating a new array each frame during chat bursts.
        for (const batch of pendingMutations) {
          handleMutations(batch);
        }
        // Reset length instead of reassigning to avoid per-frame allocation.
        pendingMutations.length = 0;
      });
    }
  };

  // Find the chat container and attach observer.
  for (const selector of CHAT_CONTAINER_SELECTORS) {
    const container = document.querySelector<HTMLElement>(selector);
    if (!container) continue;

    observer = new MutationObserver(onMutation);
    observer.observe(container, { childList: true, subtree: true });

    // Pause the observer when the tab is hidden to prevent unbounded
    // pendingMutations growth. rAF callbacks are throttled in hidden
    // tabs, so mutations would accumulate without being flushed.
    const handleVisibility = (): void => {
      if (document.visibilityState !== 'visible') {
        isPaused = true;
        observer?.disconnect();
        // Cancel any pending rAF flush — the mutations are stale and
        // will be re-fetched by the fetch interceptor on resume.
        if (mutationRafId !== null) {
          cancelAnimationFrame(mutationRafId);
          mutationRafId = null;
        }
        mutationBatchPending = false;
        pendingMutations = [];
      } else {
        isPaused = false;
        // Always disconnect before observe to prevent duplicate observers
        // if this handler re-fires while already observing.
        observer?.disconnect();
        observer?.observe(container, { childList: true, subtree: true });
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    log.info(`DOM chat watcher installed on: ${selector}`);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (mutationRafId !== null) {
        cancelAnimationFrame(mutationRafId);
        mutationRafId = null;
      }
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
