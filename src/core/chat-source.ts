/**
 * Chat Source
 *
 * Finds and monitors YouTube live chat DOM for new messages.
 * Supports both iframe and in-page chat rendering.
 */

import type {
  ChatMessage,
  ContentSegment,
  EmojiInfo,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import {
  describeChatSelector,
  findChatFrameMatch,
  findChatIframeItemMatch,
  findChatIframeMatch,
  findChatToggleButtonMatch,
  findInPageChatContainerMatch,
  isChatFrameHidden as isChatFrameHiddenElement,
} from '@core/chat-dom';
import { parseRgbColor } from '@core/design-tokens';
import { pollForValue, sleep, throwIfAborted } from '@core/dom';
import { isAllowedYouTubeImageUrl } from '@core/image-url';
import { createLogger } from '@core/logging';

const log = createLogger('ChatSource');

const CHAT_CONTAINER_SEARCH_ATTEMPTS = 8;
const CHAT_CONTAINER_SEARCH_INTERVAL_MS = 1000;
const CHAT_FRAME_SEARCH_ATTEMPTS = 10;
const CHAT_FRAME_SEARCH_INTERVAL_MS = 500;
const CHAT_FRAME_RETRY_ATTEMPTS_AFTER_OPEN = 6;
const CHAT_PANEL_SETTLE_DELAY_MS = 500;
const CHAT_PANEL_OPEN_POLL_ATTEMPTS = 10;
const CHAT_PANEL_OPEN_POLL_INTERVAL_MS = 300;
const RECENT_MESSAGE_BUFFER_SIZE = 100;
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_RETRY_DELAY_MS = 1000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 30000;
const DEFAULT_LIVE_EDGE_THRESHOLD_PX = 24;
const CHAT_IFRAME_UNSUPPORTED_TEXT_MARKERS = [
  'older version of your browser',
  'update it to use live chat',
] as const;

export type MessageCallback = (message: ChatMessage) => void;
export type ChatSourceStartStatus = 'started' | 'retryable' | 'unavailable';

type ChatMessageKind = ChatMessage['kind'];

interface ParsedMessageBody {
  text: string;
  content: ContentSegment[];
}

interface ChatHealthSnapshotOptions {
  activeTimeoutMs?: number;
  liveEdgeThresholdPx?: number;
}

export interface ChatHealthSnapshot {
  observerAlive: boolean;
  recentlyActive: boolean;
  atLiveEdge: boolean;
}

type ChatResolutionStatus = 'ready' | 'closed' | 'retryable' | 'unavailable';
type ChatContainerLookupStatus = 'ready' | 'not-found' | 'unsupported';

interface ChatResolutionOptions {
  containerAttempts: number;
  containerIntervalMs: number;
  frameRetryAttempts: number;
  frameWaitAttempts: number;
  frameWaitIntervalMs: number;
  signal?: AbortSignal | undefined;
}

type ChatResolutionResult =
  | {
      status: 'ready';
      chatFrame: HTMLElement | null;
      container: Element;
    }
  | {
      status: Exclude<ChatResolutionStatus, 'ready'>;
      chatFrame: HTMLElement | null;
    };

type ChatContainerLookupResult =
  | {
      status: 'ready';
      container: Element;
    }
  | {
      status: Exclude<ChatContainerLookupStatus, 'ready'>;
    };

export class ChatSource {
  private observer: MutationObserver | null = null;
  private chatContainer: Element | null = null;
  private callback: MessageCallback | null = null;
  private lastMessageTime = 0;
  /** Signals shutdown to in-flight async loops. Aborted by stop(). */
  private lifecycleController: AbortController | null = null;
  private reconnectInProgress = false;
  /** Tracks processed DOM nodes to prevent firing the same element twice. */
  private readonly seenElements = new WeakSet<Element>();
  /** Recent normalized messages for resume synchronization. */
  private readonly recentMessages: ChatMessage[] = [];

  constructor(private readonly getSettings: (() => Readonly<OverlaySettings>) | null = null) {}

  private combineSignals(external?: AbortSignal): AbortSignal | undefined {
    const lifecycle = this.lifecycleController?.signal;
    if (!lifecycle) return external;
    return external ? AbortSignal.any([lifecycle, external]) : lifecycle;
  }

  private isLifecycleAbort(): boolean {
    return this.lifecycleController?.signal.aborted ?? false;
  }

  /**
   * Wait for iframe content to fully load
   * Returns the #items element when it appears in the iframe's DOM
   */
  private inspectIframeContent(iframe: HTMLIFrameElement): ChatContainerLookupResult | null {
    try {
      const iframeDoc = iframe.contentDocument;
      const iframeWindow = iframe.contentWindow;
      if (!iframeDoc || iframeDoc.readyState !== 'complete') {
        return null;
      }

      const container = findChatIframeItemMatch(iframeDoc)?.element;
      if (container) {
        return { status: 'ready', container };
      }

      const iframePath = iframeWindow?.location.pathname ?? '';
      const bodyText = iframeDoc.body?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const normalizedBodyText = bodyText.toLowerCase();

      if (
        iframePath.startsWith('/live_chat') &&
        !iframeDoc.querySelector('yt-live-chat-app') &&
        CHAT_IFRAME_UNSUPPORTED_TEXT_MARKERS.some((marker) => normalizedBodyText.includes(marker))
      ) {
        log.warn('Live chat iframe rendered an unsupported browser notice instead of chat content');
        return { status: 'unsupported' };
      }
    } catch {
      return null;
    }

    return null;
  }

  private async waitForIframeContent(
    iframe: HTMLIFrameElement,
    maxAttempts = 20,
    intervalMs = 300,
    signal?: AbortSignal
  ): Promise<ChatContainerLookupResult> {
    const result = await pollForValue(() => this.inspectIframeContent(iframe), {
      attempts: maxAttempts,
      intervalMs,
      signal,
    });

    return result ?? { status: 'not-found' };
  }

  private findChatIframe(): HTMLIFrameElement | null {
    const match = findChatIframeMatch();
    if (!match) {
      log.debug('Chat iframe: not found');
      return null;
    }

    log.debug('Chat iframe found:', describeChatSelector(match.descriptor));
    log.debug('iframe src:', match.element.src);
    return match.element;
  }

  private findChatFrame(): HTMLElement | null {
    const match = findChatFrameMatch();
    return match?.element ?? null;
  }

  private findChatToggleButton(): HTMLButtonElement | null {
    const match = findChatToggleButtonMatch();
    if (!match) {
      return null;
    }

    log.debug('Found toggle button:', describeChatSelector(match.descriptor));
    return match.element;
  }

  private clickChatToggleButton(): boolean {
    const button = this.findChatToggleButton();
    if (!button) {
      return false;
    }

    button.click();
    log.debug('Clicked chat toggle button');
    return true;
  }

  /**
   * Find chat container
   * Priority A: iframe access (if same-origin)
   * Priority B: in-page render
   */
  async findChatContainer(signal?: AbortSignal): Promise<ChatContainerLookupResult> {
    log.debug('Looking for chat container...');
    log.debug('Current URL:', window.location.href);

    // Try iframe first (multiple selectors)
    const iframe = this.findChatIframe();

    if (iframe) {
      try {
        // Wait for iframe content to fully load
        const iframeResult = await this.waitForIframeContent(iframe, 20, 300, signal);
        if (iframeResult.status === 'ready') {
          log.debug('Chat container found in iframe');
          return iframeResult;
        }

        if (iframeResult.status === 'unsupported') {
          log.warn('Chat iframe is unavailable in this browser/runtime environment');
          return iframeResult;
        }

        log.debug('iframe content timeout - no #items found');
      } catch (error) {
        // Cross-origin access denied, fall through to in-page
        log.debug('iframe access denied:', error);
      }
    }

    // Try in-page chat (ordered by specificity - most specific first!)
    const inPageMatch = findInPageChatContainerMatch();
    if (inPageMatch) {
      log.debug('Chat container found:', describeChatSelector(inPageMatch.descriptor));
      return { status: 'ready', container: inPageMatch.element };
    }

    log.warn('No chat container found with any selector');
    return { status: 'not-found' };
  }

  /**
   * Wait for chat frame element to appear in DOM
   */
  private async waitForChatFrame(
    maxAttempts = 10,
    intervalMs = 500,
    signal?: AbortSignal
  ): Promise<HTMLElement | null> {
    return pollForValue(() => this.findChatFrame(), {
      attempts: maxAttempts,
      intervalMs,
      signal,
    });
  }

  private async findChatContainerWithRetries(
    attempts = CHAT_CONTAINER_SEARCH_ATTEMPTS,
    intervalMs = CHAT_CONTAINER_SEARCH_INTERVAL_MS,
    signal?: AbortSignal
  ): Promise<ChatContainerLookupResult> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      throwIfAborted(signal);

      const result = await this.findChatContainer(signal);
      if (result.status === 'ready') {
        log.debug(`Chat container found on attempt ${attempt}`);
        return result;
      }

      if (result.status === 'unsupported') {
        return result;
      }

      if (attempt < attempts) {
        await sleep(intervalMs, signal);
      }
    }

    return { status: 'not-found' };
  }

  private async resolveChatContainer(
    options: ChatResolutionOptions
  ): Promise<ChatResolutionResult> {
    const {
      frameWaitAttempts,
      frameRetryAttempts,
      frameWaitIntervalMs,
      containerAttempts,
      containerIntervalMs,
      signal,
    } = options;

    let chatFrame = await this.waitForChatFrame(frameWaitAttempts, frameWaitIntervalMs, signal);
    let openedWithoutFrame = false;

    if (!chatFrame) {
      log.warn('Chat frame element not found - chat may be disabled for this video');

      openedWithoutFrame = this.tryOpenChatPanelWithoutFrame();
      if (openedWithoutFrame) {
        chatFrame = await this.waitForChatFrame(frameRetryAttempts, frameWaitIntervalMs, signal);
        if (chatFrame) {
          await this.ensureChatPanelOpen(chatFrame, signal);
        }
      }
    } else {
      await this.ensureChatPanelOpen(chatFrame, signal);
    }

    await sleep(CHAT_PANEL_SETTLE_DELAY_MS, signal);

    const containerLookup = await this.findChatContainerWithRetries(
      containerAttempts,
      containerIntervalMs,
      signal
    );

    if (containerLookup.status === 'ready') {
      return {
        status: 'ready',
        chatFrame,
        container: containerLookup.container,
      };
    }

    if (containerLookup.status === 'unsupported') {
      return { status: 'unavailable', chatFrame };
    }

    if (chatFrame && this.isChatFrameHidden(chatFrame)) {
      return { status: 'closed', chatFrame };
    }

    if (chatFrame || openedWithoutFrame) {
      return { status: 'retryable', chatFrame };
    }

    return { status: 'unavailable', chatFrame };
  }

  private logChatResolutionFailure(
    context: 'start' | 'reconnect',
    result: Exclude<ChatResolutionResult, { status: 'ready' }>,
    containerAttempts: number
  ): void {
    const suffix = context === 'reconnect' ? ' (reconnect)' : '';

    if (result.status === 'closed') {
      log.warn(`Chat panel is still closed after attempting to open it${suffix}`);
      return;
    }

    if (result.status === 'retryable') {
      log.warn(
        `Chat surface was found, but no container became available after ${containerAttempts} attempts${suffix}`
      );
      return;
    }

    log.warn(`Chat container is unavailable${suffix}. Possible reasons:`, [
      'Chat is hidden or disabled for this video',
      'Video is not a live stream or premiere',
      'YouTube DOM structure has changed',
      'Chat is in a cross-origin iframe (blocked by browser)',
    ]);
  }

  private attachObserver(container: Element): void {
    this.observer?.disconnect();
    this.chatContainer = container;
    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    this.observer.observe(container, {
      childList: true,
      subtree: false,
    });
  }

  private rememberMessage(message: ChatMessage): void {
    this.recentMessages.push(message);

    const overflow = this.recentMessages.length - RECENT_MESSAGE_BUFFER_SIZE;
    if (overflow > 0) {
      this.recentMessages.splice(0, overflow);
    }
  }

  private getLiveEdgeDistance(container: HTMLElement): number {
    return Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
  }

  private isWithinLiveEdgeThreshold(container: HTMLElement, thresholdPx: number): boolean {
    return this.getLiveEdgeDistance(container) <= Math.max(0, thresholdPx);
  }

  private resolveScrollContainer(): HTMLElement | null {
    const base = this.chatContainer;
    if (!(base instanceof Element)) {
      return null;
    }

    const scroller = base.closest<HTMLElement>('#item-scroller') ?? base.parentElement;
    return scroller instanceof HTMLElement ? scroller : null;
  }

  isAtLiveEdge(thresholdPx = DEFAULT_LIVE_EDGE_THRESHOLD_PX): boolean {
    const container = this.resolveScrollContainer();
    if (!container) {
      // If container cannot be resolved, avoid false negatives.
      return true;
    }

    return this.isWithinLiveEdgeThreshold(container, thresholdPx);
  }

  ensureLiveEdge(thresholdPx = DEFAULT_LIVE_EDGE_THRESHOLD_PX): boolean {
    const container = this.resolveScrollContainer();
    if (!container) {
      return false;
    }

    if (this.isWithinLiveEdgeThreshold(container, thresholdPx)) {
      return true;
    }

    container.scrollTop = container.scrollHeight;
    if (this.isWithinLiveEdgeThreshold(container, thresholdPx)) {
      return true;
    }

    const lastChild = container.lastElementChild;
    if (lastChild instanceof HTMLElement) {
      lastChild.scrollIntoView({ block: 'end' });
    }

    return this.isWithinLiveEdgeThreshold(container, thresholdPx);
  }

  /**
   * Check if chat frame is hidden or collapsed
   */
  private isChatFrameHidden(chatFrame: HTMLElement): boolean {
    return isChatFrameHiddenElement(chatFrame);
  }

  /**
   * Try to open chat panel when the frame isn't in the DOM yet
   */
  private tryOpenChatPanelWithoutFrame(): boolean {
    log.debug('Chat frame missing, attempting to open chat panel...');

    try {
      if (this.clickChatToggleButton()) {
        return true;
      }
    } catch (error) {
      log.warn('Error clicking chat toggle button:', error);
    }

    log.warn('Could not find chat toggle button to open panel');
    return false;
  }

  /**
   * Check if chat panel is collapsed/hidden and try to open it
   */
  private async ensureChatPanelOpen(
    chatFrame: HTMLElement,
    signal?: AbortSignal
  ): Promise<boolean> {
    log.debug('Checking if chat panel needs to be opened...');

    // Check if chat is collapsed (hidden)
    const isHidden = this.isChatFrameHidden(chatFrame);

    if (!isHidden) {
      log.debug('Chat panel is already open');
      return true;
    }

    log.debug('Chat panel is collapsed, attempting to open...');

    try {
      if (this.clickChatToggleButton()) {
        const opened = await pollForValue(() => (this.isChatFrameHidden(chatFrame) ? null : true), {
          attempts: CHAT_PANEL_OPEN_POLL_ATTEMPTS,
          intervalMs: CHAT_PANEL_OPEN_POLL_INTERVAL_MS,
          signal,
        });

        if (opened) {
          log.debug('Successfully opened chat panel');
          return true;
        }
      }
    } catch (error) {
      log.warn('Error clicking chat toggle button:', error);
    }

    log.warn('Could not open chat panel automatically');
    return false;
  }

  /**
   * Start monitoring chat
   */
  async start(callback: MessageCallback, signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    this.lifecycleController?.abort();
    this.lifecycleController = new AbortController();
    this.callback = callback;

    const combinedSignal = this.combineSignals(signal);

    try {
      const resolution = await this.resolveChatContainer({
        frameWaitAttempts: CHAT_FRAME_SEARCH_ATTEMPTS,
        frameRetryAttempts: CHAT_FRAME_RETRY_ATTEMPTS_AFTER_OPEN,
        frameWaitIntervalMs: CHAT_FRAME_SEARCH_INTERVAL_MS,
        containerAttempts: CHAT_CONTAINER_SEARCH_ATTEMPTS,
        containerIntervalMs: CHAT_CONTAINER_SEARCH_INTERVAL_MS,
        signal: combinedSignal,
      });

      if (resolution.status !== 'ready') {
        this.logChatResolutionFailure('start', resolution, CHAT_CONTAINER_SEARCH_ATTEMPTS);
        return resolution.status === 'unavailable' ? 'unavailable' : 'retryable';
      }

      this.chatContainer = resolution.container;

      if (!this.chatContainer) {
        this.logChatResolutionFailure(
          'start',
          { status: 'unavailable', chatFrame: resolution.chatFrame },
          CHAT_CONTAINER_SEARCH_ATTEMPTS
        );
        return 'unavailable';
      }

      this.attachObserver(this.chatContainer);

      log.info('Chat monitoring started successfully');
      log.debug('Watching for new messages...');
      return 'started';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && this.isLifecycleAbort()) {
        return 'retryable';
      }
      throw error;
    }
  }

  /**
   * Handle DOM mutations (new chat messages)
   */
  private handleMutations(mutations: MutationRecord[]): void {
    if (!this.callback) return;

    const now = Date.now();

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const element = node as Element;

        // Skip elements we've already processed (guards against YouTube re-adding
        // the same DOM node, e.g. during chat panel resets or history replays).
        if (this.seenElements.has(element)) continue;
        this.seenElements.add(element);

        const message = this.parseMessage(element);
        if (message) {
          this.lastMessageTime = now;
          this.rememberMessage(message);
          this.callback(message);
        }
      }
    }
  }

  /**
   * Parse message from DOM element
   *
   * Filtering policy for overlay display:
   *   ✅ text        – yt-live-chat-text-message-renderer (regular chat messages)
   *   ✅ superchat   – yt-live-chat-paid-message-renderer  (Super Chat with text)
   *   ✅ membership  – yt-live-chat-membership-item-renderer (new/gifted member events)
   *   ❌ sticker     – yt-live-chat-paid-sticker-renderer  (image-only, no readable text)
   *   ❌ system      – viewer-engagement / banner / placeholder / timed-message
   *   ❌ other       – anything that doesn't match the above
   */
  private parseMessage(element: Element): ChatMessage | null {
    const tagName = element.tagName.toLowerCase();

    // Must be a live-chat element
    if (!tagName.startsWith('yt-live-chat-')) return null;

    // Determine message kind FIRST so per-kind filtering can follow
    const kind = this.getMessageKind(tagName);
    if (!kind) return null;

    // Filter out system messages (elements without an author, e.g. replay notice)
    if (!this.isUserMessage(element)) return null;

    try {
      const parsedBody = this.extractMessageBody(element, kind);
      if (!parsedBody) return null;

      const { text, content } = parsedBody;

      // Extract author information
      const authorType = this.extractAuthorType(element);
      const authorName = this.extractAuthorName(element);
      const authorPhotoUrl = this.extractAuthorPhotoUrl(element);

      const message: ChatMessage = {
        text,
        kind,
        timestamp: Date.now(),
      };

      if (element.id) {
        message.id = element.id;
      }

      if (content.length > 0) {
        // Add rich content if available
        message.content = content;
      }

      if (authorName) {
        // Only add optional fields if they have values
        message.author = authorName;
      }
      if (authorType) {
        message.authorType = authorType;
      }
      if (authorPhotoUrl) {
        message.authorPhotoUrl = authorPhotoUrl;
      }

      if (kind === 'superchat') {
        // Parse Super Chat specific data
        const superChatInfo = this.parseSuperChatInfo(element);
        if (superChatInfo) {
          message.superChat = superChatInfo;
        }
      }

      return message;
    } catch (error) {
      log.warn('Failed to parse message:', error);
      return null;
    }
  }

  /**
   * Stop monitoring and cleanup resources
   */
  stop(): void {
    this.lifecycleController?.abort();
    this.lifecycleController = null;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    this.chatContainer = null;
    this.callback = null;
    this.recentMessages.length = 0;

    log.debug('Chat monitoring stopped');
  }

  /**
   * Check if chat is active (received messages recently)
   */
  isActive(timeoutMs = DEFAULT_ACTIVITY_TIMEOUT_MS): boolean {
    const now = Date.now();
    return now - this.lastMessageTime < Math.max(0, timeoutMs);
  }

  getHealthSnapshot(options: ChatHealthSnapshotOptions = {}): ChatHealthSnapshot {
    const activeTimeoutMs = options.activeTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS;
    const liveEdgeThresholdPx = options.liveEdgeThresholdPx ?? DEFAULT_LIVE_EDGE_THRESHOLD_PX;
    const observerAlive = this.isObserverAlive();

    return {
      observerAlive,
      recentlyActive: this.isActive(activeTimeoutMs),
      atLiveEdge: observerAlive ? this.isAtLiveEdge(liveEdgeThresholdPx) : false,
    };
  }

  /**
   * Returns true if the MutationObserver is still attached to a live DOM node.
   * Used by the watchdog in App to detect silent observer death (e.g. YouTube
   * unmounting the chat #items container when the tab is backgrounded or the
   * chat panel is collapsed/reconstructed).
   */
  isObserverAlive(): boolean {
    return (
      this.observer !== null && this.chatContainer !== null && document.contains(this.chatContainer)
    );
  }

  /**
   * Re-acquire the chat container and re-attach the MutationObserver.
   * Called by the App watchdog when isObserverAlive() returns false.
   * Performs a single attempt; the watchdog retries on the next interval tick.
   */
  async reconnect(signal?: AbortSignal): Promise<boolean> {
    if (!this.callback || this.reconnectInProgress || this.isLifecycleAbort()) return false;

    this.reconnectInProgress = true;
    const combinedSignal = this.combineSignals(signal);

    try {
      log.info('Reconnecting MutationObserver...');
      this.observer?.disconnect();
      this.observer = null;
      this.chatContainer = null;

      const resolution = await this.resolveChatContainer({
        frameWaitAttempts: CHAT_FRAME_RETRY_ATTEMPTS_AFTER_OPEN,
        frameRetryAttempts: CHAT_FRAME_RETRY_ATTEMPTS_AFTER_OPEN,
        frameWaitIntervalMs: CHAT_FRAME_SEARCH_INTERVAL_MS,
        containerAttempts: RECONNECT_ATTEMPTS,
        containerIntervalMs: RECONNECT_RETRY_DELAY_MS,
        signal: combinedSignal,
      });

      if (resolution.status !== 'ready') {
        this.logChatResolutionFailure('reconnect', resolution, RECONNECT_ATTEMPTS);
        return false;
      }

      this.attachObserver(resolution.container);
      log.info('MutationObserver reconnected');
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && this.isLifecycleAbort()) {
        return false;
      }
      throw error;
    } finally {
      this.reconnectInProgress = false;
    }
  }

  /**
   * Snapshot the latest valid chat messages from the currently attached chat
   * container. Useful when resuming playback after pause: instead of replaying
   * stale backlog, the overlay can render the current live-chat state.
   */
  getLatestMessages(limit: number): ChatMessage[] {
    if (limit <= 0) {
      return [];
    }

    if (this.recentMessages.length > 0) {
      return this.recentMessages.slice(-limit);
    }

    if (!this.chatContainer) {
      return [];
    }

    const children = Array.from(this.chatContainer.children);
    if (children.length === 0) {
      return [];
    }

    const latest: ChatMessage[] = [];

    // Iterate from newest to oldest and keep only valid user messages.
    for (let i = children.length - 1; i >= 0 && latest.length < limit; i--) {
      const element = children[i];
      if (!(element instanceof Element)) continue;

      const message = this.parseMessage(element);
      if (!message) continue;

      latest.push(message);
    }

    // Return in chronological order (oldest -> newest) for natural rendering.
    return latest.reverse();
  }

  private getMessageKind(tagName: string): ChatMessageKind | null {
    if (tagName.includes('membership')) {
      return 'membership';
    }

    if (tagName.includes('paid')) {
      // Super Stickers (image-only) – no readable text, skip.
      if (tagName.includes('sticker')) {
        return null;
      }

      return 'superchat';
    }

    if (tagName.includes('text-message')) {
      return 'text';
    }

    // viewer-engagement, banner, placeholder, timed-message, purchase-announcement, etc.
    return null;
  }

  private extractMessageBody(element: Element, kind: ChatMessageKind): ParsedMessageBody | null {
    const messageElement = element.querySelector('#message');
    if (!messageElement) {
      return kind === 'text' ? null : { text: '', content: [] };
    }

    const parsed = this.parseMessageContent(messageElement);
    if (kind === 'text' && !this.isSubstantialText(parsed.text, element)) {
      // Drop messages that are too short to be meaningful (e.g. single-char spam like "w").
      // Exception: privileged authors (mods, owner, members) always pass through.
      return null;
    }

    return parsed;
  }

  /**
   * Check if an element represents a user message (not a system message)
   * Called AFTER kind detection in parseMessage, so purely an author-presence guard.
   */
  private isUserMessage(element: Element): boolean {
    // User messages always have a non-empty author element
    const authorElement = element.querySelector('#author-name');
    return Boolean(authorElement?.textContent?.trim());
  }

  /**
   * Decide whether a plain text message is substantial enough to show on the overlay.
   *
   * Filters out low-signal noise that clutters the screen without adding viewing value:
   *   – Single- or two-character reaction tokens ("w", "!!", "草")
   *   – Messages that are purely whitespace after stripping emoji alt text
   *
   * Privileged authors (moderator / owner / member) bypass this filter because
   * their short messages are more likely to be intentional and relevant.
   */
  private isSubstantialText(text: string, element: Element): boolean {
    const settings = this.getSettings?.();
    if (settings?.allowShortTextMessages) {
      return true;
    }

    // Privileged authors always pass through
    const privilegedBadge = element.querySelector(
      'yt-live-chat-author-badge-renderer[type="moderator"], ' +
        'yt-live-chat-author-badge-renderer[type="owner"], ' +
        'yt-live-chat-author-badge-renderer[type="member"]'
    );
    if (privilegedBadge) return true;

    // Strip emoji alt-text placeholders like "[emoji]", ":name:" to get real character count
    const stripped = text
      .replace(/\[.*?\]/g, '') // remove [emoji]
      .replace(/:[-\w]+:/g, '') // remove :emoji_name:
      .trim();

    const minLength = Math.max(1, settings?.minTextLength ?? 3);
    return stripped.length >= minLength;
  }

  /**
   * Extract author type from badge information
   */
  private extractAuthorType(element: Element): ChatMessage['authorType'] {
    // Check for badges - these indicate special user roles
    const badges = element.querySelectorAll('yt-live-chat-author-badge-renderer');

    for (const badge of badges) {
      // Check aria-label for role information
      const ariaLabel = badge.getAttribute('aria-label')?.toLowerCase() || '';
      const tooltip = badge.querySelector('#tooltip')?.textContent?.toLowerCase() || '';
      const iconType = badge.getAttribute('type')?.toLowerCase() || '';

      const badgeText = `${ariaLabel} ${tooltip} ${iconType}`;

      // Check for channel owner (highest priority)
      if (badgeText.includes('owner') || iconType.includes('owner')) {
        return 'owner';
      }

      // Check for moderator
      if (badgeText.includes('moderator') || badgeText.includes('mod')) {
        return 'moderator';
      }

      // Check for membership
      if (
        badgeText.includes('member') ||
        badgeText.includes('membership') ||
        iconType.includes('member')
      ) {
        return 'member';
      }

      // Check for verified badge
      if (badgeText.includes('verified')) {
        return 'verified';
      }
    }

    return 'normal';
  }

  /**
   * Extract author name
   */
  private extractAuthorName(element: Element): string | undefined {
    return this.getTextContent(element, '#author-name, yt-live-chat-author-chip #author-name');
  }

  /**
   * Extract author photo URL
   */
  private extractAuthorPhotoUrl(element: Element): string | undefined {
    // Try multiple selectors for author photo
    const authorPhotoElement = element.querySelector<HTMLImageElement>(
      '#author-photo img, yt-live-chat-author-chip #author-photo img, #img'
    );

    if (!authorPhotoElement) {
      return undefined;
    }

    const photoUrl = authorPhotoElement.src;

    if (!photoUrl) {
      return undefined;
    }

    // Validate URL for security
    if (!isAllowedYouTubeImageUrl(photoUrl)) {
      log.warn('Invalid author photo URL:', photoUrl);
      return undefined;
    }

    return photoUrl;
  }

  /**
   * Normalize text content
   */
  private normalizeText(text: string): string {
    // Remove control characters
    let normalized = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

    // Collapse whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();

    // Limit length (80 chars)
    if (normalized.length > 80) {
      normalized = `${normalized.substring(0, 77)}...`;
    }

    return normalized;
  }

  /**
   * Detect emoji type (standard/custom/member)
   */
  private detectEmojiType(img: HTMLImageElement): EmojiInfo['type'] {
    // Check for member-only indicators
    const ariaLabel = img.getAttribute('aria-label')?.toLowerCase() || '';
    const tooltip =
      img.getAttribute('shared-tooltip-text')?.toLowerCase() ||
      img.getAttribute('tooltip')?.toLowerCase() ||
      '';
    const classList = img.className.toLowerCase();

    // Member-only emoji detection
    // YouTube typically marks member emojis with specific classes or attributes
    if (
      img.hasAttribute('data-is-custom-emoji') ||
      img.hasAttribute('data-membership-required') ||
      classList.includes('member') ||
      ariaLabel.includes('member') ||
      tooltip.includes('member') ||
      // Check parent for membership badge
      img.closest('yt-live-chat-author-badge-renderer[type="member"]')
    ) {
      return 'member';
    }

    // Custom emoji (non-member)
    if (
      classList.includes('custom') ||
      classList.includes('yt-live-chat-custom-emoji') ||
      img.hasAttribute('data-emoji-id')
    ) {
      return 'custom';
    }

    // Standard emoji (Unicode)
    return 'standard';
  }

  /**
   * Parse emoji from img element
   */
  private parseEmoji(img: HTMLImageElement): EmojiInfo | null {
    const src = img.src;
    if (!src || !isAllowedYouTubeImageUrl(src)) {
      return null;
    }

    const alt =
      img.alt || img.getAttribute('shared-tooltip-text') || img.getAttribute('aria-label') || '';

    const emojiType = this.detectEmojiType(img);

    const emojiInfo: EmojiInfo = {
      type: emojiType,
      url: src,
      alt,
    };

    // Add optional properties only if they have values
    const width = img.naturalWidth || img.width;
    if (width) {
      emojiInfo.width = width;
    }

    const height = img.naturalHeight || img.height;
    if (height) {
      emojiInfo.height = height;
    }

    const id = img.id || img.getAttribute('data-emoji-id');
    if (id) {
      emojiInfo.id = id;
    }

    return emojiInfo;
  }

  /**
   * Parse message content with emojis
   * Returns both plain text and rich content segments
   */
  private parseMessageContent(messageElement: Element): {
    text: string;
    content: ContentSegment[];
  } {
    const segments: ContentSegment[] = [];
    let plainText = '';

    // Traverse child nodes in order
    const processNode = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim() || '';
        if (text) {
          segments.push({ type: 'text', content: text });
          plainText += text;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as Element;

        // Check if it's an emoji image
        if (
          elem.tagName.toLowerCase() === 'img' &&
          (elem.classList.contains('emoji') ||
            elem.hasAttribute('data-emoji-id') ||
            elem.closest('#message') === messageElement)
        ) {
          const emojiInfo = this.parseEmoji(elem as HTMLImageElement);
          if (emojiInfo) {
            segments.push({ type: 'emoji', emoji: emojiInfo });
            // Add alt text to plain text for fallback
            plainText += emojiInfo.alt || '[emoji]';
            return; // Don't process children of img
          }
        }

        // Recursively process child nodes
        for (const child of elem.childNodes) {
          processNode(child);
        }
      }
    };

    // Process all child nodes
    for (const child of messageElement.childNodes) {
      processNode(child);
    }

    return {
      text: this.normalizeText(plainText),
      content: segments,
    };
  }

  private getTextContent(root: ParentNode, selector: string): string | undefined {
    return root.querySelector(selector)?.textContent?.trim() || undefined;
  }

  /**
   * Parse Super Chat information from element
   */
  private parseSuperChatInfo(element: Element): SuperChatInfo | null {
    try {
      // Extract purchase amount and currency
      const amountText =
        this.getTextContent(element, '#purchase-amount, yt-formatted-string#purchase-amount') || '';

      if (!amountText) {
        log.warn('Super Chat detected but no amount found');
        return null;
      }

      // Parse amount and currency (e.g., "$5.00", "¥500", "₩5,000")
      // Common formats: "$5.00", "5.00 USD", "¥500", "₩5,000", "€5.00"
      const currencyMatch = amountText.match(/[A-Z]{3}/) || [];
      const currency = currencyMatch[0];

      // Extract colors from element styles
      const computedStyle = window.getComputedStyle(element);
      const backgroundColor = computedStyle.backgroundColor || undefined;

      // Try to find header background color (from card-header element)
      const headerElement = element.querySelector(
        '#card, #header, yt-live-chat-paid-message-renderer #card'
      );
      const headerBackgroundColor = headerElement
        ? window.getComputedStyle(headerElement).backgroundColor || undefined
        : undefined;

      const tier = this.determineSuperChatTier(backgroundColor);

      // Check for sticker (high-tier Super Chats may have stickers)
      const stickerImg = element.querySelector(
        '#sticker img, yt-img-shadow#sticker img, img[id*="sticker"]'
      ) as HTMLImageElement;
      const stickerUrl =
        stickerImg && isAllowedYouTubeImageUrl(stickerImg.src) ? stickerImg.src : undefined;

      const superChatInfo: SuperChatInfo = {
        amount: amountText,
        tier,
      };

      // Add optional fields only if they have values
      if (currency) {
        superChatInfo.currency = currency;
      }
      if (backgroundColor) {
        superChatInfo.backgroundColor = backgroundColor;
      }
      if (headerBackgroundColor) {
        superChatInfo.headerBackgroundColor = headerBackgroundColor;
      }
      if (stickerUrl) {
        superChatInfo.stickerUrl = stickerUrl;
      }

      return superChatInfo;
    } catch (error) {
      log.warn('Failed to parse Super Chat info:', error);
      return null;
    }
  }

  /**
   * Determine Super Chat tier based on background color.
   * YouTube uses different colors for different price tiers; we map the
   * computed backgroundColor to the closest tier and fall back to 'blue'
   * when the color cannot be parsed.
   */
  private determineSuperChatTier(backgroundColor: string | undefined): SuperChatInfo['tier'] {
    const rgb = backgroundColor ? parseRgbColor(backgroundColor) : null;
    if (!rgb) return 'blue';

    const { r, g, b } = rgb;

    if (r > 200 && g < 100 && b < 100) return 'red';
    if (r > 200 && g < 100 && b > 80) return 'magenta';
    if (r > 200 && g > 100 && g < 150 && b < 50) return 'orange';
    if (r > 200 && g > 180 && b < 100) return 'yellow';
    if (r < 100 && g > 200 && b > 150) return 'green';
    if (r < 100 && g > 150 && b > 200) return 'cyan';
    return 'blue';
  }
}
