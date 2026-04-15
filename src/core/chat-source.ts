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
  CHAT_CONTAINER_SELECTORS,
  CHAT_FRAME_SELECTORS,
  CHAT_IFRAME_ITEM_SELECTORS,
  CHAT_IFRAME_SELECTORS,
  CHAT_TOGGLE_BUTTON_SELECTORS,
  debugLogChatElements,
  isChatFrameHidden as isChatFrameHiddenElement,
  validateChatElement,
} from '@core/chat-dom';
import { parseRgbColor } from '@core/design-tokens';
import { findElementMatch, pollForValue, sleep } from '@core/dom';
import { isAllowedYouTubeImageUrl } from '@core/image-url';
import { overlayLog } from '@core/logging';

const CHAT_CONTAINER_SEARCH_ATTEMPTS = 8;
const CHAT_CONTAINER_SEARCH_INTERVAL_MS = 1000;
const RECENT_MESSAGE_BUFFER_SIZE = 100;
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_RETRY_DELAY_MS = 1000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 30000;
const DEFAULT_LIVE_EDGE_THRESHOLD_PX = 24;

export type MessageCallback = (message: ChatMessage) => void;

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

export class ChatSource {
  private observer: MutationObserver | null = null;
  private chatContainer: Element | null = null;
  private callback: MessageCallback | null = null;
  private lastMessageTime = 0;
  /** Set to true by stop() to cancel any in-flight start() async loops. */
  private stopped = false;
  private reconnectInProgress = false;
  /** Tracks processed DOM nodes to prevent firing the same element twice. */
  private readonly seenElements = new WeakSet<Element>();
  /** Recent normalized messages for resume synchronization. */
  private readonly recentMessages: ChatMessage[] = [];

  constructor(private readonly getSettings: (() => Readonly<OverlaySettings>) | null = null) {}

  /**
   * Wait for iframe content to fully load
   * Returns the #items element when it appears in the iframe's DOM
   */
  private async waitForIframeContent(
    iframe: HTMLIFrameElement,
    maxAttempts = 20,
    intervalMs = 300
  ): Promise<Element | null> {
    return pollForValue(
      () => {
        try {
          const iframeDoc = iframe.contentDocument;
          if (!iframeDoc || iframeDoc.readyState !== 'complete') {
            return null;
          }

          return findElementMatch<Element>(CHAT_IFRAME_ITEM_SELECTORS, {
            root: iframeDoc,
          })?.element;
        } catch {
          return null;
        }
      },
      { attempts: maxAttempts, intervalMs }
    );
  }

  private findChatIframe(): HTMLIFrameElement | null {
    const match = findElementMatch<HTMLIFrameElement>(CHAT_IFRAME_SELECTORS);
    if (!match) {
      overlayLog.info('[YT Chat Overlay] Chat iframe: not found');
      return null;
    }

    overlayLog.info(`[YT Chat Overlay] Chat iframe found with selector: ${match.selector}`);
    overlayLog.info('[YT Chat Overlay] iframe src:', match.element.src);
    return match.element;
  }

  private findChatFrame(): HTMLElement | null {
    const match = findElementMatch<HTMLElement>(CHAT_FRAME_SELECTORS);
    return match?.element ?? null;
  }

  private findChatToggleButton(): HTMLButtonElement | null {
    const match = findElementMatch<HTMLButtonElement>(CHAT_TOGGLE_BUTTON_SELECTORS, {
      predicate: (element) => !element.disabled,
    });

    if (!match) {
      return null;
    }

    overlayLog.info(`[YT Chat Overlay] Found toggle button with selector: ${match.selector}`);
    return match.element;
  }

  private clickChatToggleButton(): boolean {
    const button = this.findChatToggleButton();
    if (!button) {
      return false;
    }

    button.click();
    overlayLog.info('[YT Chat Overlay] Clicked chat toggle button');
    return true;
  }

  /**
   * Find chat container
   * Priority A: iframe access (if same-origin)
   * Priority B: in-page render
   */
  async findChatContainer(): Promise<Element | null> {
    overlayLog.info('[YT Chat Overlay] Looking for chat container...');
    overlayLog.info('[YT Chat Overlay] Current URL:', window.location.href);

    // Debug: Log what chat-related elements exist (debug level only)
    if (this.getSettings?.().logLevel === 'debug') {
      debugLogChatElements();
    }

    // Try iframe first (multiple selectors)
    const iframe = this.findChatIframe();

    if (iframe) {
      try {
        // Wait for iframe content to fully load
        const container = await this.waitForIframeContent(iframe);
        if (container) {
          overlayLog.info('[YT Chat Overlay] Chat container found in iframe');
          return container;
        }
        overlayLog.info('[YT Chat Overlay] iframe content timeout - no #items found');
      } catch (error) {
        // Cross-origin access denied, fall through to in-page
        overlayLog.info('[YT Chat Overlay] iframe access denied:', error);
      }
    }

    // Try in-page chat (ordered by specificity - most specific first!)
    const inPageMatch = findElementMatch<Element>(CHAT_CONTAINER_SELECTORS, {
      predicate: (element) => validateChatElement(element),
    });

    if (inPageMatch) {
      overlayLog.info(
        `[YT Chat Overlay] Chat container found with selector: ${inPageMatch.selector}`
      );
      return inPageMatch.element;
    }

    console.warn('[YT Chat Overlay] No chat container found with any selector');
    return null;
  }

  /**
   * Wait for chat frame element to appear in DOM
   */
  private async waitForChatFrame(maxAttempts = 10, intervalMs = 500): Promise<HTMLElement | null> {
    return pollForValue(() => this.findChatFrame(), {
      attempts: maxAttempts,
      intervalMs,
    });
  }

  private async findChatContainerWithRetries(
    attempts = CHAT_CONTAINER_SEARCH_ATTEMPTS,
    intervalMs = CHAT_CONTAINER_SEARCH_INTERVAL_MS
  ): Promise<Element | null> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.stopped) {
        return null;
      }

      const container = await this.findChatContainer();
      if (container) {
        overlayLog.info(`[YT Chat Overlay] Chat container found on attempt ${attempt}`);
        return container;
      }

      if (attempt < attempts) {
        await sleep(intervalMs);
      }
    }

    return null;
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

  private resolveScrollContainer(): HTMLElement | null {
    const base = this.chatContainer;
    if (!(base instanceof Element)) {
      return null;
    }

    const ownerDocument = base.ownerDocument;
    const candidates: Array<Element | null> = [
      base,
      base.parentElement,
      base.closest('#item-scroller'),
      base.closest('yt-live-chat-item-list-renderer'),
      ownerDocument?.querySelector('#item-scroller'),
      ownerDocument?.querySelector('yt-live-chat-item-list-renderer'),
    ];

    const visited = new Set<HTMLElement>();

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || visited.has(candidate)) {
        continue;
      }

      visited.add(candidate);

      const view = candidate.ownerDocument?.defaultView;
      const overflowY = view?.getComputedStyle(candidate).overflowY ?? '';
      const isScrollableStyle =
        overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
      const hasScrollableContent = candidate.scrollHeight > candidate.clientHeight + 1;

      if (isScrollableStyle || hasScrollableContent) {
        return candidate;
      }
    }

    return null;
  }

  isAtLiveEdge(thresholdPx = DEFAULT_LIVE_EDGE_THRESHOLD_PX): boolean {
    const container = this.resolveScrollContainer();
    if (!container) {
      // If container cannot be resolved, avoid false negatives.
      return true;
    }

    const distance = Math.max(
      0,
      container.scrollHeight - container.clientHeight - container.scrollTop
    );
    return distance <= Math.max(0, thresholdPx);
  }

  ensureLiveEdge(thresholdPx = DEFAULT_LIVE_EDGE_THRESHOLD_PX): boolean {
    const container = this.resolveScrollContainer();
    if (!container) {
      return false;
    }

    if (this.isAtLiveEdge(thresholdPx)) {
      return true;
    }

    container.scrollTop = container.scrollHeight;
    if (this.isAtLiveEdge(thresholdPx)) {
      return true;
    }

    const lastChild = container.lastElementChild;
    if (lastChild instanceof HTMLElement) {
      lastChild.scrollIntoView({ block: 'end' });
    }

    return this.isAtLiveEdge(thresholdPx);
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
  private async tryOpenChatPanelWithoutFrame(): Promise<boolean> {
    overlayLog.info('[YT Chat Overlay] Chat frame missing, attempting to open chat panel...');

    try {
      if (this.clickChatToggleButton()) {
        return true;
      }
    } catch (error) {
      console.warn('[YT Chat Overlay] Error clicking chat toggle button:', error);
    }

    console.warn('[YT Chat Overlay] Could not find chat toggle button to open panel');
    return false;
  }

  /**
   * Check if chat panel is collapsed/hidden and try to open it
   */
  private async ensureChatPanelOpen(chatFrame: HTMLElement): Promise<boolean> {
    overlayLog.info('[YT Chat Overlay] Checking if chat panel needs to be opened...');

    // Check if chat is collapsed (hidden)
    const isHidden = this.isChatFrameHidden(chatFrame);

    if (!isHidden) {
      overlayLog.info('[YT Chat Overlay] Chat panel is already open');
      return true;
    }

    overlayLog.info('[YT Chat Overlay] Chat panel is collapsed, attempting to open...');

    // Try to find and click the chat toggle button
    try {
      if (this.clickChatToggleButton()) {
        // Wait for panel to open
        await sleep(1000);

        // Verify panel is now open
        if (!this.isChatFrameHidden(chatFrame)) {
          overlayLog.info('[YT Chat Overlay] Successfully opened chat panel');
          return true;
        }
      }
    } catch (error) {
      console.warn('[YT Chat Overlay] Error clicking chat toggle button:', error);
    }

    console.warn('[YT Chat Overlay] Could not open chat panel automatically');
    return false;
  }

  private async prepareChatPanelForReconnect(): Promise<void> {
    const chatFrame = this.findChatFrame();
    if (!chatFrame) {
      return;
    }

    try {
      await this.ensureChatPanelOpen(chatFrame);
    } catch (error) {
      console.warn('[YT Chat Overlay] Failed to reopen chat panel before reconnect:', error);
    }
  }

  /**
   * Start monitoring chat
   */
  async start(callback: MessageCallback): Promise<boolean> {
    this.stopped = false;
    this.callback = callback;

    // First, wait for chat frame element to exist in DOM
    let chatFrame = await this.waitForChatFrame();
    if (this.stopped) return false;

    if (!chatFrame) {
      console.warn(
        '[YT Chat Overlay] Chat frame element not found - chat may be disabled for this video'
      );
      const opened = await this.tryOpenChatPanelWithoutFrame();
      if (opened) {
        chatFrame = await this.waitForChatFrame(6, 500);
        if (this.stopped) return false;
        if (chatFrame) {
          await this.ensureChatPanelOpen(chatFrame);
          if (this.stopped) return false;
        }
      }
      // Continue anyway - might be in-page chat
    } else {
      // Ensure chat panel is open
      await this.ensureChatPanelOpen(chatFrame);
      if (this.stopped) return false;
    }

    // Wait a bit for chat iframe to load if it was just opened
    await sleep(500);
    if (this.stopped) return false;

    // Find chat container with bounded retries
    this.chatContainer = await this.findChatContainerWithRetries();

    if (this.stopped) return false;

    if (!this.chatContainer) {
      console.warn(
        `[YT Chat Overlay] Chat container not found after ${CHAT_CONTAINER_SEARCH_ATTEMPTS} attempts`
      );
      console.warn('[YT Chat Overlay] Possible reasons:');
      console.warn('  1. Chat is hidden or disabled for this video');
      console.warn('  2. Video is not a live stream or premiere');
      console.warn('  3. YouTube DOM structure has changed');
      console.warn('  4. Chat is in a cross-origin iframe (blocked by browser)');
      return false;
    }

    // Final cancellation check before attaching observer
    if (this.stopped) return false;

    this.attachObserver(this.chatContainer);

    overlayLog.info('[YT Chat Overlay] Chat monitoring started successfully');
    overlayLog.info('[YT Chat Overlay] Watching for new messages...');
    return true;
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
      console.warn('[YT Chat Overlay] Failed to parse message:', error);
      return null;
    }
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

    // Get image URL (prefer src, fallback to srcset)
    const photoUrl = authorPhotoElement.src || authorPhotoElement.getAttribute('src');

    if (!photoUrl) {
      return undefined;
    }

    // Validate URL for security
    if (!isAllowedYouTubeImageUrl(photoUrl)) {
      console.warn('[YT Chat Overlay] Invalid author photo URL:', photoUrl);
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
        console.warn('[YT Chat Overlay] Super Chat detected but no amount found');
        return null;
      }

      // Parse amount and currency (e.g., "$5.00", "¥500", "₩5,000")
      // Common formats: "$5.00", "5.00 USD", "¥500", "₩5,000", "€5.00"
      const currencyMatch = amountText.match(/[A-Z]{3}/) || [];
      const currency = currencyMatch[0];

      // Extract colors from element styles
      const computedStyle = window.getComputedStyle(element);
      const backgroundColor =
        computedStyle.backgroundColor ||
        element.getAttribute('style')?.match(/background-color:\s*([^;]+)/)?.[1] ||
        undefined;

      // Try to find header background color (from card-header element)
      const headerElement = element.querySelector(
        '#card, #header, yt-live-chat-paid-message-renderer #card'
      );
      const headerBackgroundColor = headerElement
        ? window.getComputedStyle(headerElement).backgroundColor || undefined
        : undefined;

      // Determine color tier based on background color or amount
      const tier = this.determineSuperChatTier(backgroundColor, amountText);

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
      console.warn('[YT Chat Overlay] Failed to parse Super Chat info:', error);
      return null;
    }
  }

  /**
   * Determine Super Chat tier based on background color or amount
   * YouTube uses different colors for different price tiers
   */
  private determineSuperChatTier(
    backgroundColor: string | undefined,
    amountText: string
  ): SuperChatInfo['tier'] {
    if (!backgroundColor) {
      // Fallback: estimate tier from amount text
      const numericAmount = parseFloat(amountText.replace(/[^0-9.]/g, ''));
      if (numericAmount >= 100) return 'red';
      if (numericAmount >= 50) return 'magenta';
      if (numericAmount >= 20) return 'orange';
      if (numericAmount >= 10) return 'yellow';
      if (numericAmount >= 5) return 'green';
      if (numericAmount >= 2) return 'cyan';
      return 'blue';
    }

    // Parse RGB values from backgroundColor
    const rgb = parseRgbColor(backgroundColor);
    if (!rgb) return 'blue'; // fallback

    const { r, g, b } = rgb;

    // YouTube Super Chat color tiers (approximate RGB ranges)
    // Red: $100+ (rgb(230, 33, 23))
    if (r > 200 && g < 100 && b < 100) return 'red';
    // Magenta: $50-$99 (rgb(233, 30, 99))
    if (r > 200 && g < 100 && b > 80) return 'magenta';
    // Orange: $20-$49 (rgb(245, 124, 0))
    if (r > 200 && g > 100 && g < 150 && b < 50) return 'orange';
    // Yellow: $10-$19 (rgb(255, 202, 40))
    if (r > 200 && g > 180 && b < 100) return 'yellow';
    // Green: $5-$9 (rgb(29, 233, 182))
    if (r < 100 && g > 200 && b > 150) return 'green';
    // Cyan: $2-$4 (rgb(0, 191, 255))
    if (r < 100 && g > 150 && b > 200) return 'cyan';
    // Blue: $1-$1.99 (rgb(30, 136, 229))
    return 'blue';
  }

  /**
   * Stop monitoring and cleanup resources
   */
  stop(): void {
    // Signal any in-flight start() async loops to abort
    this.stopped = true;

    // Disconnect observer
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    // Clear references
    this.chatContainer = null;
    this.callback = null;
    this.recentMessages.length = 0;

    overlayLog.info('[YT Chat Overlay] Chat monitoring stopped');
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

    return {
      observerAlive: this.isObserverAlive(),
      recentlyActive: this.isActive(activeTimeoutMs),
      atLiveEdge: this.isAtLiveEdge(liveEdgeThresholdPx),
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
  async reconnect(): Promise<boolean> {
    if (this.stopped || !this.callback || this.reconnectInProgress) return false;

    this.reconnectInProgress = true;

    try {
      overlayLog.info('[YT Chat Overlay] Reconnecting MutationObserver...');
      this.observer?.disconnect();
      this.observer = null;
      this.chatContainer = null;

      await this.prepareChatPanelForReconnect();
      if (this.stopped) return false;

      const container = await this.findChatContainerWithRetries(
        RECONNECT_ATTEMPTS,
        RECONNECT_RETRY_DELAY_MS
      );
      if (this.stopped || !container) return false;

      this.attachObserver(container);
      overlayLog.info('[YT Chat Overlay] MutationObserver reconnected');
      return true;
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
}
