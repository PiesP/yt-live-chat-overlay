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
import { MAX_REGULAR_MESSAGE_TEXT_LENGTH } from '@chat/message-helpers';
import { createLogger } from '@util/logging';

const log = createLogger('DomChatWatcher');

/**
 * YouTube chat container selectors.
 * The chat iframe (#chatframe) is cross-origin on some YouTube layouts,
 * so we watch the host-page chat container instead.
 */
const CHAT_LIST_RENDERER_TAG = 'yt-live-chat-item-list-renderer';

const TEXT_MESSAGE_RENDERER_SELECTOR = 'yt-live-chat-text-message-renderer';
const AUTHOR_NAME_SELECTOR = '#author-name';
const MESSAGE_SELECTOR = '#message';
const DOM_NODE_VISIT_MULTIPLIER = 16;

type DomMessageCallback = (messages: ChatMessage[]) => void;

export type DomWatcherUnsubscribe = (() => void) | null;

function findChatContainer(): HTMLElement | null {
  const items = document.getElementById('items');
  if (items instanceof HTMLElement) {
    let ancestor = items.parentElement;
    while (ancestor) {
      if (ancestor.localName === CHAT_LIST_RENDERER_TAG) return items;
      ancestor = ancestor.parentElement;
    }
  }

  const renderers = document.getElementsByTagName(CHAT_LIST_RENDERER_TAG);
  const renderer = renderers.item(0);
  return renderer instanceof HTMLElement ? renderer : null;
}

/**
 * Install a MutationObserver that watches YouTube's chat DOM for new messages.
 *
 * @param onMessages Called with parsed ChatMessage[] whenever new chat DOM nodes appear.
 * @returns          Unsubscribe function that disconnects the observer.
 */
export function installDomChatWatcher(
  onMessages: DomMessageCallback,
  getMessageCapacity: () => number = () => 1000,
  onPendingRecordCount?: (count: number) => void,
  onNodeVisitCount?: (count: number) => void,
  onExtractedCharacterCount?: (count: number) => void
): DomWatcherUnsubscribe {
  let observer: MutationObserver | null = null;
  let mutationBatchPending = false;
  let mutationRafId: number | null = null;
  let pendingMutations: MutationRecord[] = [];
  let isPaused = false;

  const resolveCapacity = (): number => {
    const configuredCapacity = Math.floor(getMessageCapacity());
    return Number.isFinite(configuredCapacity)
      ? Math.max(1, Math.min(1000, configuredCapacity))
      : 1;
  };

  const extractMessages = (
    addedNodes: NodeList,
    messages: ChatMessage[],
    capacity: number,
    visitBudget: { remaining: number; visited: number },
    extractedCharacters: { count: number }
  ): void => {
    const now = Date.now();

    const chargeVisit = (): boolean => {
      if (visitBudget.remaining <= 0) return false;
      visitBudget.remaining--;
      visitBudget.visited++;
      return true;
    };

    const nextDepthFirst = (current: Node, root: Node, descend: boolean): Node | null => {
      if (descend && current.firstChild) return current.firstChild;
      let cursor: Node | null = current;
      while (cursor && cursor !== root && !cursor.nextSibling) {
        cursor = cursor.parentNode;
      }
      return cursor && cursor !== root ? cursor.nextSibling : null;
    };

    const findRendererFields = (
      renderer: HTMLElement
    ): { author: Element | null; message: Element | null } => {
      let author: Element | null = null;
      let message: Element | null = null;
      let current: Node | null = renderer.firstChild;
      while (current && visitBudget.remaining > 0 && (!author || !message)) {
        if (!chargeVisit()) break;
        let descend = true;
        if (current.nodeType === Node.ELEMENT_NODE) {
          const element = current as Element;
          if (!author && element.id === AUTHOR_NAME_SELECTOR.slice(1)) {
            author = element;
            descend = false;
          } else if (!message && element.id === MESSAGE_SELECTOR.slice(1)) {
            message = element;
            descend = false;
          }
        }
        current = nextDepthFirst(current, renderer, descend);
      }
      return { author, message };
    };

    const extractBoundedText = (root: Element | null): string => {
      if (!root) return '';
      let result = '';
      let characters = 0;
      let current: Node | null = root.firstChild;
      while (current && visitBudget.remaining > 0 && characters < MAX_REGULAR_MESSAGE_TEXT_LENGTH) {
        if (!chargeVisit()) break;
        if (current.nodeType === Node.TEXT_NODE) {
          for (const codePoint of (current as Text).data) {
            if (characters >= MAX_REGULAR_MESSAGE_TEXT_LENGTH) break;
            result += codePoint;
            characters++;
            extractedCharacters.count++;
          }
        }
        current = nextDepthFirst(current, root, true);
      }
      return result.trim();
    };

    const appendRenderer = (renderer: HTMLElement): void => {
      if (messages.length >= capacity || visitBudget.remaining <= 0) return;
      const fields = findRendererFields(renderer);
      if (!fields.message || visitBudget.remaining <= 0) return;
      const author = extractBoundedText(fields.author);
      const text = extractBoundedText(fields.message);
      if (!text) return;

      const rawId = renderer.id;
      messages.push({
        ...(rawId ? { id: rawId } : {}),
        text,
        content: [{ type: 'text', content: text }],
        kind: 'text',
        timestamp: now,
        author,
        authorType: 'normal',
      });
    };

    const traverseNode = (root: Node): void => {
      let current: Node | null = root;
      while (current && messages.length < capacity && visitBudget.remaining > 0) {
        if (!chargeVisit()) break;
        const isRenderer =
          current.nodeType === Node.ELEMENT_NODE &&
          (current as Element).localName === TEXT_MESSAGE_RENDERER_SELECTOR;
        if (isRenderer) appendRenderer(current as HTMLElement);
        current = nextDepthFirst(current, root, !isRenderer);
      }
    };

    for (let i = 0; i < addedNodes.length; i++) {
      if (messages.length >= capacity || visitBudget.remaining <= 0) break;
      const node = addedNodes[i];
      if (!node) continue;
      traverseNode(node);
    }
  };

  const handleMutations = (mutations: readonly MutationRecord[], capacity: number): void => {
    const allMessages: ChatMessage[] = [];
    const visitBudget = {
      remaining: capacity * DOM_NODE_VISIT_MULTIPLIER,
      visited: 0,
    };
    const extractedCharacters = { count: 0 };

    for (const mutation of mutations) {
      if (allMessages.length >= capacity || visitBudget.remaining <= 0) break;
      if (mutation.type !== 'childList') continue;
      if (mutation.addedNodes.length === 0) continue;
      extractMessages(mutation.addedNodes, allMessages, capacity, visitBudget, extractedCharacters);
    }
    onNodeVisitCount?.(visitBudget.visited);
    onExtractedCharacterCount?.(extractedCharacters.count);

    if (allMessages.length > 0) {
      log.debug('chat.dom-watcher.captured', { count: allMessages.length });
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
    const capacity = resolveCapacity();
    for (const mutation of mutations) {
      if (pendingMutations.length >= capacity) break;
      pendingMutations.push(mutation);
    }
    onPendingRecordCount?.(pendingMutations.length);
    if (!mutationBatchPending) {
      mutationBatchPending = true;
      mutationRafId = requestAnimationFrame(() => {
        mutationBatchPending = false;
        mutationRafId = null;
        const retainedMutations = pendingMutations;
        pendingMutations = [];
        handleMutations(retainedMutations, resolveCapacity());
      });
    }
  };

  // Find the chat container and attach observer.
  // NOTE: YouTube may embed chat in a cross-origin iframe (e.g. #chatframe),
  // which is inaccessible to MutationObserver from the host page. When that
  // happens, no selector below matches and the DOM watcher silently falls
  // back to the fetch-interceptor primary path — that is the expected
  // degraded mode, not a bug.
  const container = findChatContainer();
  if (container) {
    observer = new MutationObserver(onMutation);
    observer.observe(container, { childList: true, subtree: true });

    // Pause the observer when the tab is hidden to prevent unbounded
    // pendingMutations growth. rAF callbacks are throttled in hidden
    // tabs, so mutations would accumulate without being flushed.
    const handleVisibility = (): void => {
      if (document.visibilityState !== 'visible') {
        // Disconnect observer BEFORE setting isPaused to prevent a race:
        // if a mutation fires between isPaused=true and disconnect(),
        // onMutation drops it silently (isPaused guard).  Disconnecting
        // first ensures no callbacks fire during the gap.
        observer?.disconnect();
        isPaused = true;
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

    log.info('chat.dom-watcher.installed');
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (mutationRafId !== null) {
        cancelAnimationFrame(mutationRafId);
        mutationRafId = null;
      }
      mutationBatchPending = false;
      pendingMutations = [];
      isPaused = true;
      observer?.disconnect();
      observer = null;
      log.info('chat.dom-watcher.removed');
    };
  }

  // No container found — return null so callers can retry later.
  log.info(
    'No chat container found — DOM watcher not installed. ' +
      'YouTube chat may be in a cross-origin iframe (#chatframe) ' +
      'inaccessible from the content script. Falling back to fetch interceptor.'
  );
  return null;
}
