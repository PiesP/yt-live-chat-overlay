/**
 * Chat Source
 *
 * Finds and monitors YouTube live chat DOM for new messages.
 * Supports both iframe and in-page chat rendering.
 */

import type { ChatMessage, ContentSegment, EmojiInfo } from '@app-types';
import { findElementMatch, sleep } from '@core/dom';

const CHAT_FRAME_SELECTORS = ['ytd-live-chat-frame#chat', '#chat', 'ytd-live-chat-frame'] as const;

const CHAT_IFRAME_SELECTORS = [
  'iframe[src*="live_chat"]',
  'iframe#chatframe',
  'ytd-live-chat-frame iframe',
  '#chat iframe',
] as const;

const CHAT_IFRAME_ITEM_SELECTORS = [
  '#items.yt-live-chat-item-list-renderer',
  '#items',
  'yt-live-chat-item-list-renderer #items',
] as const;

const CHAT_CONTAINER_SELECTORS = [
  // Most specific selectors first
  '#chat #items.yt-live-chat-item-list-renderer',
  '#items.yt-live-chat-item-list-renderer',
  'yt-live-chat-item-list-renderer #items',
  'ytd-live-chat-frame yt-live-chat-item-list-renderer',
  'yt-live-chat-app yt-live-chat-item-list-renderer',

  // Frame-based selectors
  'ytd-live-chat-frame #items',

  // App-based selectors
  'yt-live-chat-app #items',

  // Chat panel selectors
  '#chat-container #items',
  '#chat #items',
  'ytd-live-chat #items',

  // Tag-based selector
  'yt-live-chat-item-list-renderer',

  // Generic selectors (LAST - most likely to match wrong elements!)
  // NOTE: #items can match sidebar elements, so we validate it
  '#items',
] as const;

const CHAT_TOGGLE_BUTTON_SELECTORS = [
  // Theater mode toggle button
  'ytd-toggle-button-renderer button[aria-label*="chat" i]',
  'ytd-toggle-button-renderer button[aria-label*="채팅" i]',
  // Live chat button
  'button#show-hide-button',
  // Engagement panel toggle
  'ytd-engagement-panel-title-header-renderer button',
  // Engagement panel list buttons
  'ytd-engagement-panel-section-list-renderer button[aria-label*="chat" i]',
  'ytd-engagement-panel-section-list-renderer button[aria-label*="채팅" i]',
  // Generic chat-related buttons (ignore overlay settings button)
  'button:not(#yt-chat-overlay-settings-button)[aria-label*="show chat" i]',
  'button:not(#yt-chat-overlay-settings-button)[aria-label*="open chat" i]',
  'button:not(#yt-chat-overlay-settings-button)[aria-label*="chat" i]',
  'button:not(#yt-chat-overlay-settings-button)[aria-label*="채팅" i]',
] as const;

export type MessageCallback = (message: ChatMessage) => void;

export class ChatSource {
  private observer: MutationObserver | null = null;
  private chatContainer: Element | null = null;
  private callback: MessageCallback | null = null;
  private lastMessageTime = 0;

  /**
   * Wait for iframe content to fully load
   * Returns the #items element when it appears in the iframe's DOM
   */
  private async waitForIframeContent(
    iframe: HTMLIFrameElement,
    maxAttempts = 20,
    intervalMs = 300
  ): Promise<Element | null> {
    console.log(
      `[YT Chat Overlay] Waiting for iframe content to load (max ${maxAttempts} attempts, ${intervalMs}ms interval)...`
    );

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) {
          console.log(`[YT Chat Overlay] iframe content attempt ${i + 1}: contentDocument is null`);
          await sleep(intervalMs);
          continue;
        }

        // Check if document is still loading
        if (iframeDoc.readyState !== 'complete') {
          console.log(
            `[YT Chat Overlay] iframe content attempt ${i + 1}: readyState = ${iframeDoc.readyState}`
          );
          await sleep(intervalMs);
          continue;
        }

        const containerMatch = findElementMatch<Element>(CHAT_IFRAME_ITEM_SELECTORS, {
          root: iframeDoc,
        });
        if (containerMatch) {
          console.log(
            `[YT Chat Overlay] iframe content ready on attempt ${i + 1}: found with selector "${containerMatch.selector}"`
          );
          return containerMatch.element;
        }

        console.log(
          `[YT Chat Overlay] iframe content attempt ${i + 1}: document complete but #items not found yet`
        );
      } catch (error) {
        console.log(`[YT Chat Overlay] iframe content attempt ${i + 1}: error - ${error}`);
      }

      await sleep(intervalMs);
    }

    console.warn('[YT Chat Overlay] iframe content did not load within timeout');
    return null;
  }

  /**
   * Find chat container
   * Priority A: iframe access (if same-origin)
   * Priority B: in-page render
   */
  async findChatContainer(): Promise<Element | null> {
    console.log('[YT Chat Overlay] Looking for chat container...');
    console.log('[YT Chat Overlay] Current URL:', window.location.href);

    // Debug: Log what chat-related elements exist
    this.debugLogChatElements();

    // Try iframe first (multiple selectors)
    let iframe: HTMLIFrameElement | null = null;
    for (const selector of CHAT_IFRAME_SELECTORS) {
      iframe = document.querySelector<HTMLIFrameElement>(selector);
      if (iframe) {
        console.log(`[YT Chat Overlay] Chat iframe found with selector: ${selector}`);
        console.log('[YT Chat Overlay] iframe src:', iframe.src);
        break;
      }
    }

    if (!iframe) {
      console.log('[YT Chat Overlay] Chat iframe: not found');
    }

    if (iframe) {
      try {
        // Wait for iframe content to fully load
        const container = await this.waitForIframeContent(iframe);
        if (container) {
          console.log('[YT Chat Overlay] Chat container found in iframe');
          return container;
        }
        console.log('[YT Chat Overlay] iframe content timeout - no #items found');
      } catch (error) {
        // Cross-origin access denied, fall through to in-page
        console.log('[YT Chat Overlay] iframe access denied:', error);
      }
    }

    // Try in-page chat (ordered by specificity - most specific first!)
    console.log(`[YT Chat Overlay] Trying ${CHAT_CONTAINER_SELECTORS.length} in-page selectors...`);
    for (const selector of CHAT_CONTAINER_SELECTORS) {
      const element = document.querySelector(selector);
      if (element) {
        // Validate: check if this is actually a chat-related element
        const isValidChatElement = this.validateChatElement(element);
        if (!isValidChatElement) {
          console.log(
            `[YT Chat Overlay] Selector "${selector}" matched but element is not chat-related, skipping`
          );
          continue;
        }

        console.log(`[YT Chat Overlay] Chat container found with selector: ${selector}`);
        console.log(
          '[YT Chat Overlay] Container tag:',
          element.tagName,
          'id:',
          element.id,
          'class:',
          element.className
        );
        return element;
      }
    }

    console.warn('[YT Chat Overlay] No chat container found with any selector');
    return null;
  }

  /**
   * Validate that an element is actually a chat container
   * Prevents matching non-chat elements like sidebar menus
   */
  private validateChatElement(element: Element): boolean {
    // Check parent chain for chat-related elements
    let current: Element | null = element;
    let depth = 0;
    const maxDepth = 10;

    while (current && depth < maxDepth) {
      const tagName = current.tagName.toLowerCase();
      const className = current.className.toLowerCase();
      const id = current.id.toLowerCase();

      // Positive indicators (chat-related)
      if (
        tagName.includes('chat') ||
        className.includes('chat') ||
        id.includes('chat') ||
        tagName === 'yt-live-chat-app' ||
        tagName === 'ytd-live-chat-frame' ||
        tagName === 'yt-live-chat-item-list-renderer'
      ) {
        console.log(
          `[YT Chat Overlay] Element validated: found chat-related parent at depth ${depth}`
        );
        return true;
      }

      // Negative indicators (not chat)
      if (
        tagName === 'ytd-mini-guide-renderer' ||
        tagName === 'ytd-guide-renderer' ||
        className.includes('guide') ||
        className.includes('sidebar') ||
        id.includes('guide')
      ) {
        console.log(
          `[YT Chat Overlay] Element rejected: found non-chat parent "${tagName}" at depth ${depth}`
        );
        return false;
      }

      current = current.parentElement;
      depth++;
    }

    // If we didn't find clear indicators either way, be conservative
    console.log('[YT Chat Overlay] Element validation inconclusive, rejecting');
    return false;
  }

  /**
   * Debug: Log available chat-related elements
   */
  private debugLogChatElements(): void {
    console.log('[YT Chat Overlay] === DEBUG: Chat Elements ===');

    // Check for common chat elements
    const chatElements = document.querySelectorAll(
      '[id*="chat"], [class*="chat"], yt-live-chat-app, ytd-live-chat-frame'
    );
    console.log(
      `[YT Chat Overlay] Found ${chatElements.length} elements with 'chat' in id/class or live chat tags`
    );

    chatElements.forEach((el, i) => {
      if (i < 5) {
        // Limit to first 5 to avoid spam
        console.log(
          `  [${i}] ${el.tagName} id="${el.id}" class="${el.className.substring(0, 50)}"`
        );
      }
    });

    // Check for iframes
    const allIframes = document.querySelectorAll('iframe');
    console.log(`[YT Chat Overlay] Found ${allIframes.length} total iframes`);
    allIframes.forEach((iframe, i) => {
      if (iframe.src.includes('chat')) {
        console.log(`  iframe[${i}] src="${iframe.src}"`);
      }
    });

    console.log('[YT Chat Overlay] === END DEBUG ===');
  }

  /**
   * Wait for chat frame element to appear in DOM
   */
  private async waitForChatFrame(maxAttempts = 10, intervalMs = 500): Promise<HTMLElement | null> {
    console.log(
      `[YT Chat Overlay] Waiting for chat frame element (max ${maxAttempts} attempts, ${intervalMs}ms interval)...`
    );

    for (let i = 0; i < maxAttempts; i++) {
      for (const selector of CHAT_FRAME_SELECTORS) {
        const chatFrame = document.querySelector(selector) as HTMLElement;
        if (chatFrame) {
          console.log(
            `[YT Chat Overlay] Chat frame found on attempt ${i + 1} with selector: ${selector}`
          );
          return chatFrame;
        }
      }

      console.log(`[YT Chat Overlay] Chat frame attempt ${i + 1}: not found yet`);
      await sleep(intervalMs);
    }

    console.warn('[YT Chat Overlay] Chat frame element not found within timeout');
    return null;
  }

  /**
   * Check if chat frame is hidden or collapsed
   */
  private isChatFrameHidden(chatFrame: HTMLElement): boolean {
    if (
      chatFrame.hasAttribute('collapsed') ||
      chatFrame.hasAttribute('hidden') ||
      chatFrame.getAttribute('aria-hidden') === 'true'
    ) {
      return true;
    }

    if (chatFrame.style.display === 'none' || chatFrame.style.visibility === 'hidden') {
      return true;
    }

    if (chatFrame.offsetWidth === 0 || chatFrame.offsetHeight === 0) {
      return true;
    }

    const hiddenAncestor = chatFrame.closest('[hidden], [aria-hidden="true"]');
    return Boolean(hiddenAncestor);
  }

  /**
   * Try to open chat panel when the frame isn't in the DOM yet
   */
  private async tryOpenChatPanelWithoutFrame(): Promise<boolean> {
    console.log('[YT Chat Overlay] Chat frame missing, attempting to open chat panel...');

    for (const selector of CHAT_TOGGLE_BUTTON_SELECTORS) {
      try {
        const button = document.querySelector(selector) as HTMLButtonElement;
        if (button) {
          console.log(`[YT Chat Overlay] Found toggle button with selector: ${selector}`);
          button.click();
          console.log('[YT Chat Overlay] Clicked chat toggle button');
          return true;
        }
      } catch (error) {
        console.warn(
          `[YT Chat Overlay] Error clicking toggle button with selector ${selector}:`,
          error
        );
      }
    }

    console.warn('[YT Chat Overlay] Could not find chat toggle button to open panel');
    return false;
  }

  /**
   * Check if chat panel is collapsed/hidden and try to open it
   */
  private async ensureChatPanelOpen(chatFrame: HTMLElement): Promise<boolean> {
    console.log('[YT Chat Overlay] Checking if chat panel needs to be opened...');

    // Check if chat is collapsed (hidden)
    const isHidden = this.isChatFrameHidden(chatFrame);

    if (!isHidden) {
      console.log('[YT Chat Overlay] Chat panel is already open');
      return true;
    }

    console.log('[YT Chat Overlay] Chat panel is collapsed, attempting to open...');

    // Try to find and click the chat toggle button
    for (const selector of CHAT_TOGGLE_BUTTON_SELECTORS) {
      try {
        const button = document.querySelector(selector) as HTMLButtonElement;
        if (button) {
          console.log(`[YT Chat Overlay] Found toggle button with selector: ${selector}`);
          button.click();
          console.log('[YT Chat Overlay] Clicked chat toggle button');

          // Wait for panel to open
          await sleep(1000);

          // Verify panel is now open
          const isNowOpen = !this.isChatFrameHidden(chatFrame);

          if (isNowOpen) {
            console.log('[YT Chat Overlay] Successfully opened chat panel');
            return true;
          }
        }
      } catch (error) {
        console.warn(
          `[YT Chat Overlay] Error clicking toggle button with selector ${selector}:`,
          error
        );
      }
    }

    // If no button found or click didn't work, try to remove collapsed attribute directly
    try {
      let removed = false;
      if (chatFrame.hasAttribute('collapsed')) {
        chatFrame.removeAttribute('collapsed');
        removed = true;
      }
      if (chatFrame.hasAttribute('hidden')) {
        chatFrame.removeAttribute('hidden');
        removed = true;
      }
      if (removed) {
        console.log('[YT Chat Overlay] Removed collapsed/hidden attributes from chat frame');
        await sleep(500);
        return true;
      }
    } catch (error) {
      console.warn('[YT Chat Overlay] Error removing collapsed/hidden attributes:', error);
    }

    console.warn('[YT Chat Overlay] Could not open chat panel automatically');
    return false;
  }

  /**
   * Start monitoring chat
   */
  async start(callback: MessageCallback): Promise<boolean> {
    this.callback = callback;

    // First, wait for chat frame element to exist in DOM
    let chatFrame = await this.waitForChatFrame();
    if (!chatFrame) {
      console.warn(
        '[YT Chat Overlay] Chat frame element not found - chat may be disabled for this video'
      );
      const opened = await this.tryOpenChatPanelWithoutFrame();
      if (opened) {
        chatFrame = await this.waitForChatFrame(6, 500);
        if (chatFrame) {
          await this.ensureChatPanelOpen(chatFrame);
        }
      }
      // Continue anyway - might be in-page chat
    } else {
      // Ensure chat panel is open
      await this.ensureChatPanelOpen(chatFrame);
    }

    // Wait a bit for chat iframe to load if it was just opened
    await sleep(500);

    // Find chat container (with retries)
    console.log('[YT Chat Overlay] Starting chat container search (10 attempts)...');
    for (let i = 0; i < 10; i++) {
      console.log(`[YT Chat Overlay] Attempt ${i + 1}/10...`);
      this.chatContainer = await this.findChatContainer();
      if (this.chatContainer) {
        console.log(`[YT Chat Overlay] Chat container found on attempt ${i + 1}`);
        break;
      }
      // Exponential backoff: 1s, 2s, 3s, 4s, 5s, 5s, 5s, 5s, 5s, 5s
      const delay = Math.min(1000 * (i + 1), 5000);
      console.log(`[YT Chat Overlay] Waiting ${delay}ms before next attempt...`);
      await sleep(delay);
    }

    if (!this.chatContainer) {
      console.warn('[YT Chat Overlay] Chat container not found after 10 attempts');
      console.warn('[YT Chat Overlay] Possible reasons:');
      console.warn('  1. Chat is hidden or disabled for this video');
      console.warn('  2. Video is not a live stream or premiere');
      console.warn('  3. YouTube DOM structure has changed');
      console.warn('  4. Chat is in a cross-origin iframe (blocked by browser)');
      return false;
    }

    // Setup MutationObserver
    this.observer = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    this.observer.observe(this.chatContainer, {
      childList: true,
      subtree: false,
    });

    console.log('[YT Chat Overlay] Chat monitoring started successfully');
    console.log('[YT Chat Overlay] Watching for new messages...');
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
        const message = this.parseMessage(element);
        if (message) {
          this.lastMessageTime = now;
          this.callback(message);
        }
      }
    }
  }

  /**
   * Parse message from DOM element
   */
  private parseMessage(element: Element): ChatMessage | null {
    // Check for text message renderer
    if (!element.tagName.toLowerCase().includes('chat') || !element.querySelector('#message')) {
      return null;
    }

    try {
      // Extract text content and emojis
      const messageElement = element.querySelector('#message');
      if (!messageElement) return null;

      // Parse content with emojis
      const { text, content } = this.parseMessageContent(messageElement);

      if (!text) return null;

      // Determine message kind
      let kind: ChatMessage['kind'] = 'text';
      if (element.tagName.toLowerCase().includes('paid')) {
        kind = 'superchat';
      } else if (element.tagName.toLowerCase().includes('membership')) {
        kind = 'membership';
      }

      // For now, only process text messages
      if (kind !== 'text') return null;

      // Extract author information
      const authorType = this.extractAuthorType(element);
      const authorName = this.extractAuthorName(element);

      const message: ChatMessage = {
        text,
        kind,
        timestamp: Date.now(),
      };

      // Add rich content if available
      if (content.length > 0) {
        message.content = content;
      }

      // Only add optional fields if they have values
      if (authorName) {
        message.author = authorName;
      }
      if (authorType) {
        message.authorType = authorType;
      }

      return message;
    } catch (error) {
      console.warn('[YT Chat Overlay] Failed to parse message:', error);
      return null;
    }
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

      // Check for owner/verified first (highest priority)
      if (badgeText.includes('owner') || badgeText.includes('verified')) {
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
    const authorElement = element.querySelector(
      '#author-name, yt-live-chat-author-chip #author-name'
    );
    return authorElement?.textContent?.trim();
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
   * Validate image URL (security)
   * Only allow YouTube CDN domains
   */
  private isValidImageUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      // Only allow YouTube's CDN domains
      const allowedDomains = [
        'yt3.ggpht.com',
        'yt4.ggpht.com',
        'www.gstatic.com',
        'lh3.googleusercontent.com',
      ];
      return allowedDomains.some((domain) => parsed.hostname.includes(domain));
    } catch {
      return false;
    }
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
    if (!src || !this.isValidImageUrl(src)) {
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

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.chatContainer = null;
    this.callback = null;
    console.log('[YT Chat Overlay] Chat monitoring stopped');
  }

  /**
   * Check if chat is active (received messages recently)
   */
  isActive(): boolean {
    const now = Date.now();
    return now - this.lastMessageTime < 30000; // 30 seconds
  }
}
