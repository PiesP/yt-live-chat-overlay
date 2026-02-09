// ==UserScript==
// @name         YouTube Live Chat Overlay
// @version      0.1.1
// @description  Displays YouTube live chat in Nico-nico style flowing overlay (100% local, no data collection)
// @author       PiesP
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-end
// @icon         https://www.youtube.com/favicon.ico
// @homepage     https://github.com/PiesP/yt-live-chat-overlay
// @supportURL   https://github.com/PiesP/yt-live-chat-overlay/issues
// @license      MIT
// @namespace    https://github.com/PiesP
// ==/UserScript==

/* LEGAL NOTICE:
 * This userscript operates ENTIRELY in the user's browser (100% local processing).
 * NO chat data is stored, transmitted, or processed externally.
 * Only user settings (font size, speed, etc.) are stored in localStorage.
 * This is NOT an official YouTube or Nico-nico product.
 * YouTube UI/content is NOT modified - only an overlay is added.
 */
(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    speedPxPerSec: 240,
    fontSize: 26,
    opacity: 0.92,
    safeTop: 0.08,
    safeBottom: 0.15,
    maxConcurrentMessages: 24,
    maxMessagesPerSecond: 6,
    colors: {
      normal: "#FFFFFF",
      // White for normal users
      member: "#0F9D58",
      // Green for members
      moderator: "#5E84F1",
      // Blue for moderators
      owner: "#FFD600",
      // Gold/Yellow for channel owner
      verified: "#AAAAAA"
      // Gray for verified users
    },
    outline: {
      enabled: true,
      widthPx: 1,
      blurPx: 1,
      opacity: 0.5
    }
  };

  const PLAYER_CONTAINER_SELECTORS$1 = [
    "#movie_player",
    ".html5-video-player",
    "ytd-player",
    "#player-container"
  ];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisibleElement = (element) => element.offsetWidth > 0 && element.offsetHeight > 0;
  const findElementMatch = (selectors, options = {}) => {
    const { root = document, predicate } = options;
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (!element) continue;
      if (predicate && !predicate(element)) continue;
      return { element, selector };
    }
    return null;
  };
  const waitForElementMatch = async (selectors, options = {}) => {
    const { attempts = 5, intervalMs = 500, root, predicate } = options;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const match = findElementMatch(selectors, {
        ...root ? { root } : {},
        ...predicate ? { predicate } : {}
      });
      if (match) return match;
      await sleep(intervalMs);
    }
    return null;
  };

  const CHAT_FRAME_SELECTORS = ["ytd-live-chat-frame#chat", "#chat", "ytd-live-chat-frame"];
  const CHAT_IFRAME_SELECTORS = [
    'iframe[src*="live_chat"]',
    "iframe#chatframe",
    "ytd-live-chat-frame iframe",
    "#chat iframe"
  ];
  const CHAT_IFRAME_ITEM_SELECTORS = [
    "#items.yt-live-chat-item-list-renderer",
    "#items",
    "yt-live-chat-item-list-renderer #items"
  ];
  const CHAT_CONTAINER_SELECTORS = [
    // Most specific selectors first
    "#chat #items.yt-live-chat-item-list-renderer",
    "#items.yt-live-chat-item-list-renderer",
    "yt-live-chat-item-list-renderer #items",
    "ytd-live-chat-frame yt-live-chat-item-list-renderer",
    "yt-live-chat-app yt-live-chat-item-list-renderer",
    // Frame-based selectors
    "ytd-live-chat-frame #items",
    // App-based selectors
    "yt-live-chat-app #items",
    // Chat panel selectors
    "#chat-container #items",
    "#chat #items",
    "ytd-live-chat #items",
    // Tag-based selector
    "yt-live-chat-item-list-renderer",
    // Generic selectors (LAST - most likely to match wrong elements!)
    // NOTE: #items can match sidebar elements, so we validate it
    "#items"
  ];
  const CHAT_TOGGLE_BUTTON_SELECTORS = [
    // Theater mode toggle button
    'ytd-toggle-button-renderer button[aria-label*="chat" i]',
    'ytd-toggle-button-renderer button[aria-label*="채팅" i]',
    // Live chat button
    "button#show-hide-button",
    // Engagement panel toggle
    "ytd-engagement-panel-title-header-renderer button",
    // Engagement panel list buttons
    'ytd-engagement-panel-section-list-renderer button[aria-label*="chat" i]',
    'ytd-engagement-panel-section-list-renderer button[aria-label*="채팅" i]',
    // Generic chat-related buttons (ignore overlay settings button)
    'button:not(#yt-chat-overlay-settings-button)[aria-label*="show chat" i]',
    'button:not(#yt-chat-overlay-settings-button)[aria-label*="open chat" i]',
    'button:not(#yt-chat-overlay-settings-button)[aria-label*="chat" i]',
    'button:not(#yt-chat-overlay-settings-button)[aria-label*="채팅" i]'
  ];
  class ChatSource {
    observer = null;
    chatContainer = null;
    callback = null;
    lastMessageTime = 0;
    /**
     * Wait for iframe content to fully load
     * Returns the #items element when it appears in the iframe's DOM
     */
    async waitForIframeContent(iframe, maxAttempts = 20, intervalMs = 300) {
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
          if (iframeDoc.readyState !== "complete") {
            console.log(
              `[YT Chat Overlay] iframe content attempt ${i + 1}: readyState = ${iframeDoc.readyState}`
            );
            await sleep(intervalMs);
            continue;
          }
          const containerMatch = findElementMatch(CHAT_IFRAME_ITEM_SELECTORS, {
            root: iframeDoc
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
      console.warn("[YT Chat Overlay] iframe content did not load within timeout");
      return null;
    }
    /**
     * Find chat container
     * Priority A: iframe access (if same-origin)
     * Priority B: in-page render
     */
    async findChatContainer() {
      console.log("[YT Chat Overlay] Looking for chat container...");
      console.log("[YT Chat Overlay] Current URL:", window.location.href);
      this.debugLogChatElements();
      let iframe = null;
      for (const selector of CHAT_IFRAME_SELECTORS) {
        iframe = document.querySelector(selector);
        if (iframe) {
          console.log(`[YT Chat Overlay] Chat iframe found with selector: ${selector}`);
          console.log("[YT Chat Overlay] iframe src:", iframe.src);
          break;
        }
      }
      if (!iframe) {
        console.log("[YT Chat Overlay] Chat iframe: not found");
      }
      if (iframe) {
        try {
          const container = await this.waitForIframeContent(iframe);
          if (container) {
            console.log("[YT Chat Overlay] Chat container found in iframe");
            return container;
          }
          console.log("[YT Chat Overlay] iframe content timeout - no #items found");
        } catch (error) {
          console.log("[YT Chat Overlay] iframe access denied:", error);
        }
      }
      console.log(`[YT Chat Overlay] Trying ${CHAT_CONTAINER_SELECTORS.length} in-page selectors...`);
      for (const selector of CHAT_CONTAINER_SELECTORS) {
        const element = document.querySelector(selector);
        if (element) {
          const isValidChatElement = this.validateChatElement(element);
          if (!isValidChatElement) {
            console.log(
              `[YT Chat Overlay] Selector "${selector}" matched but element is not chat-related, skipping`
            );
            continue;
          }
          console.log(`[YT Chat Overlay] Chat container found with selector: ${selector}`);
          console.log(
            "[YT Chat Overlay] Container tag:",
            element.tagName,
            "id:",
            element.id,
            "class:",
            element.className
          );
          return element;
        }
      }
      console.warn("[YT Chat Overlay] No chat container found with any selector");
      return null;
    }
    /**
     * Validate that an element is actually a chat container
     * Prevents matching non-chat elements like sidebar menus
     */
    validateChatElement(element) {
      let current = element;
      let depth = 0;
      const maxDepth = 10;
      while (current && depth < maxDepth) {
        const tagName = current.tagName.toLowerCase();
        const className = current.className.toLowerCase();
        const id = current.id.toLowerCase();
        if (tagName.includes("chat") || className.includes("chat") || id.includes("chat") || tagName === "yt-live-chat-app" || tagName === "ytd-live-chat-frame" || tagName === "yt-live-chat-item-list-renderer") {
          console.log(
            `[YT Chat Overlay] Element validated: found chat-related parent at depth ${depth}`
          );
          return true;
        }
        if (tagName === "ytd-mini-guide-renderer" || tagName === "ytd-guide-renderer" || className.includes("guide") || className.includes("sidebar") || id.includes("guide")) {
          console.log(
            `[YT Chat Overlay] Element rejected: found non-chat parent "${tagName}" at depth ${depth}`
          );
          return false;
        }
        current = current.parentElement;
        depth++;
      }
      console.log("[YT Chat Overlay] Element validation inconclusive, rejecting");
      return false;
    }
    /**
     * Debug: Log available chat-related elements
     */
    debugLogChatElements() {
      console.log("[YT Chat Overlay] === DEBUG: Chat Elements ===");
      const chatElements = document.querySelectorAll(
        '[id*="chat"], [class*="chat"], yt-live-chat-app, ytd-live-chat-frame'
      );
      console.log(
        `[YT Chat Overlay] Found ${chatElements.length} elements with 'chat' in id/class or live chat tags`
      );
      chatElements.forEach((el, i) => {
        if (i < 5) {
          console.log(
            `  [${i}] ${el.tagName} id="${el.id}" class="${el.className.substring(0, 50)}"`
          );
        }
      });
      const allIframes = document.querySelectorAll("iframe");
      console.log(`[YT Chat Overlay] Found ${allIframes.length} total iframes`);
      allIframes.forEach((iframe, i) => {
        if (iframe.src.includes("chat")) {
          console.log(`  iframe[${i}] src="${iframe.src}"`);
        }
      });
      console.log("[YT Chat Overlay] === END DEBUG ===");
    }
    /**
     * Wait for chat frame element to appear in DOM
     */
    async waitForChatFrame(maxAttempts = 10, intervalMs = 500) {
      console.log(
        `[YT Chat Overlay] Waiting for chat frame element (max ${maxAttempts} attempts, ${intervalMs}ms interval)...`
      );
      for (let i = 0; i < maxAttempts; i++) {
        for (const selector of CHAT_FRAME_SELECTORS) {
          const chatFrame = document.querySelector(selector);
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
      console.warn("[YT Chat Overlay] Chat frame element not found within timeout");
      return null;
    }
    /**
     * Check if chat frame is hidden or collapsed
     */
    isChatFrameHidden(chatFrame) {
      if (chatFrame.hasAttribute("collapsed") || chatFrame.hasAttribute("hidden") || chatFrame.getAttribute("aria-hidden") === "true") {
        return true;
      }
      if (chatFrame.style.display === "none" || chatFrame.style.visibility === "hidden") {
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
    async tryOpenChatPanelWithoutFrame() {
      console.log("[YT Chat Overlay] Chat frame missing, attempting to open chat panel...");
      for (const selector of CHAT_TOGGLE_BUTTON_SELECTORS) {
        try {
          const button = document.querySelector(selector);
          if (button) {
            console.log(`[YT Chat Overlay] Found toggle button with selector: ${selector}`);
            button.click();
            console.log("[YT Chat Overlay] Clicked chat toggle button");
            return true;
          }
        } catch (error) {
          console.warn(
            `[YT Chat Overlay] Error clicking toggle button with selector ${selector}:`,
            error
          );
        }
      }
      console.warn("[YT Chat Overlay] Could not find chat toggle button to open panel");
      return false;
    }
    /**
     * Check if chat panel is collapsed/hidden and try to open it
     */
    async ensureChatPanelOpen(chatFrame) {
      console.log("[YT Chat Overlay] Checking if chat panel needs to be opened...");
      const isHidden = this.isChatFrameHidden(chatFrame);
      if (!isHidden) {
        console.log("[YT Chat Overlay] Chat panel is already open");
        return true;
      }
      console.log("[YT Chat Overlay] Chat panel is collapsed, attempting to open...");
      for (const selector of CHAT_TOGGLE_BUTTON_SELECTORS) {
        try {
          const button = document.querySelector(selector);
          if (button) {
            console.log(`[YT Chat Overlay] Found toggle button with selector: ${selector}`);
            button.click();
            console.log("[YT Chat Overlay] Clicked chat toggle button");
            await sleep(1e3);
            const isNowOpen = !this.isChatFrameHidden(chatFrame);
            if (isNowOpen) {
              console.log("[YT Chat Overlay] Successfully opened chat panel");
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
      try {
        let removed = false;
        if (chatFrame.hasAttribute("collapsed")) {
          chatFrame.removeAttribute("collapsed");
          removed = true;
        }
        if (chatFrame.hasAttribute("hidden")) {
          chatFrame.removeAttribute("hidden");
          removed = true;
        }
        if (removed) {
          console.log("[YT Chat Overlay] Removed collapsed/hidden attributes from chat frame");
          await sleep(500);
          return true;
        }
      } catch (error) {
        console.warn("[YT Chat Overlay] Error removing collapsed/hidden attributes:", error);
      }
      console.warn("[YT Chat Overlay] Could not open chat panel automatically");
      return false;
    }
    /**
     * Start monitoring chat
     */
    async start(callback) {
      this.callback = callback;
      let chatFrame = await this.waitForChatFrame();
      if (!chatFrame) {
        console.warn(
          "[YT Chat Overlay] Chat frame element not found - chat may be disabled for this video"
        );
        const opened = await this.tryOpenChatPanelWithoutFrame();
        if (opened) {
          chatFrame = await this.waitForChatFrame(6, 500);
          if (chatFrame) {
            await this.ensureChatPanelOpen(chatFrame);
          }
        }
      } else {
        await this.ensureChatPanelOpen(chatFrame);
      }
      await sleep(500);
      console.log("[YT Chat Overlay] Starting chat container search (10 attempts)...");
      for (let i = 0; i < 10; i++) {
        console.log(`[YT Chat Overlay] Attempt ${i + 1}/10...`);
        this.chatContainer = await this.findChatContainer();
        if (this.chatContainer) {
          console.log(`[YT Chat Overlay] Chat container found on attempt ${i + 1}`);
          break;
        }
        const delay = Math.min(1e3 * (i + 1), 5e3);
        console.log(`[YT Chat Overlay] Waiting ${delay}ms before next attempt...`);
        await sleep(delay);
      }
      if (!this.chatContainer) {
        console.warn("[YT Chat Overlay] Chat container not found after 10 attempts");
        console.warn("[YT Chat Overlay] Possible reasons:");
        console.warn("  1. Chat is hidden or disabled for this video");
        console.warn("  2. Video is not a live stream or premiere");
        console.warn("  3. YouTube DOM structure has changed");
        console.warn("  4. Chat is in a cross-origin iframe (blocked by browser)");
        return false;
      }
      this.observer = new MutationObserver((mutations) => {
        this.handleMutations(mutations);
      });
      this.observer.observe(this.chatContainer, {
        childList: true,
        subtree: false
      });
      console.log("[YT Chat Overlay] Chat monitoring started successfully");
      console.log("[YT Chat Overlay] Watching for new messages...");
      return true;
    }
    /**
     * Handle DOM mutations (new chat messages)
     */
    handleMutations(mutations) {
      if (!this.callback) return;
      const now = Date.now();
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = node;
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
    parseMessage(element) {
      if (!element.tagName.toLowerCase().includes("chat") || !element.querySelector("#message")) {
        return null;
      }
      if (!this.isUserMessage(element)) {
        return null;
      }
      try {
        const messageElement = element.querySelector("#message");
        if (!messageElement) return null;
        const { text, content } = this.parseMessageContent(messageElement);
        if (!text) return null;
        let kind = "text";
        if (element.tagName.toLowerCase().includes("paid")) {
          kind = "superchat";
        } else if (element.tagName.toLowerCase().includes("membership")) {
          kind = "membership";
        }
        if (kind !== "text") return null;
        const authorType = this.extractAuthorType(element);
        const authorName = this.extractAuthorName(element);
        const message = {
          text,
          kind,
          timestamp: Date.now()
        };
        if (content.length > 0) {
          message.content = content;
        }
        if (authorName) {
          message.author = authorName;
        }
        if (authorType) {
          message.authorType = authorType;
        }
        return message;
      } catch (error) {
        console.warn("[YT Chat Overlay] Failed to parse message:", error);
        return null;
      }
    }
    /**
     * Check if an element represents a user message (not a system message)
     * System messages don't have authors and use different renderer types
     */
    isUserMessage(element) {
      const authorElement = element.querySelector("#author-name");
      if (!authorElement || !authorElement.textContent?.trim()) {
        return false;
      }
      const tagName = element.tagName.toLowerCase();
      const systemMessageTypes = [
        "placeholder",
        // "Using live chat replay" / "실시간 채팅 다시보기"
        "timed-message",
        // Time-based notifications
        "viewer-engagement",
        // Engagement notifications
        "banner"
        // System banners
      ];
      for (const type of systemMessageTypes) {
        if (tagName.includes(type)) {
          return false;
        }
      }
      return true;
    }
    /**
     * Extract author type from badge information
     */
    extractAuthorType(element) {
      const badges = element.querySelectorAll("yt-live-chat-author-badge-renderer");
      for (const badge of badges) {
        const ariaLabel = badge.getAttribute("aria-label")?.toLowerCase() || "";
        const tooltip = badge.querySelector("#tooltip")?.textContent?.toLowerCase() || "";
        const iconType = badge.getAttribute("type")?.toLowerCase() || "";
        const badgeText = `${ariaLabel} ${tooltip} ${iconType}`;
        if (badgeText.includes("owner") || badgeText.includes("verified")) {
          return "owner";
        }
        if (badgeText.includes("moderator") || badgeText.includes("mod")) {
          return "moderator";
        }
        if (badgeText.includes("member") || badgeText.includes("membership") || iconType.includes("member")) {
          return "member";
        }
        if (badgeText.includes("verified")) {
          return "verified";
        }
      }
      return "normal";
    }
    /**
     * Extract author name
     */
    extractAuthorName(element) {
      const authorElement = element.querySelector(
        "#author-name, yt-live-chat-author-chip #author-name"
      );
      return authorElement?.textContent?.trim();
    }
    /**
     * Normalize text content
     */
    normalizeText(text) {
      let normalized = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
      normalized = normalized.replace(/\s+/g, " ").trim();
      if (normalized.length > 80) {
        normalized = `${normalized.substring(0, 77)}...`;
      }
      return normalized;
    }
    /**
     * Validate image URL (security)
     * Only allow YouTube CDN domains
     */
    isValidImageUrl(url) {
      try {
        const parsed = new URL(url);
        const allowedDomains = [
          "yt3.ggpht.com",
          "yt4.ggpht.com",
          "www.gstatic.com",
          "lh3.googleusercontent.com"
        ];
        return allowedDomains.some((domain) => parsed.hostname.includes(domain));
      } catch {
        return false;
      }
    }
    /**
     * Detect emoji type (standard/custom/member)
     */
    detectEmojiType(img) {
      const ariaLabel = img.getAttribute("aria-label")?.toLowerCase() || "";
      const tooltip = img.getAttribute("shared-tooltip-text")?.toLowerCase() || img.getAttribute("tooltip")?.toLowerCase() || "";
      const classList = img.className.toLowerCase();
      if (img.hasAttribute("data-is-custom-emoji") || img.hasAttribute("data-membership-required") || classList.includes("member") || ariaLabel.includes("member") || tooltip.includes("member") || // Check parent for membership badge
      img.closest('yt-live-chat-author-badge-renderer[type="member"]')) {
        return "member";
      }
      if (classList.includes("custom") || classList.includes("yt-live-chat-custom-emoji") || img.hasAttribute("data-emoji-id")) {
        return "custom";
      }
      return "standard";
    }
    /**
     * Parse emoji from img element
     */
    parseEmoji(img) {
      const src = img.src;
      if (!src || !this.isValidImageUrl(src)) {
        return null;
      }
      const alt = img.alt || img.getAttribute("shared-tooltip-text") || img.getAttribute("aria-label") || "";
      const emojiType = this.detectEmojiType(img);
      const emojiInfo = {
        type: emojiType,
        url: src,
        alt
      };
      const width = img.naturalWidth || img.width;
      if (width) {
        emojiInfo.width = width;
      }
      const height = img.naturalHeight || img.height;
      if (height) {
        emojiInfo.height = height;
      }
      const id = img.id || img.getAttribute("data-emoji-id");
      if (id) {
        emojiInfo.id = id;
      }
      return emojiInfo;
    }
    /**
     * Parse message content with emojis
     * Returns both plain text and rich content segments
     */
    parseMessageContent(messageElement) {
      const segments = [];
      let plainText = "";
      const processNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.trim() || "";
          if (text) {
            segments.push({ type: "text", content: text });
            plainText += text;
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const elem = node;
          if (elem.tagName.toLowerCase() === "img" && (elem.classList.contains("emoji") || elem.hasAttribute("data-emoji-id") || elem.closest("#message") === messageElement)) {
            const emojiInfo = this.parseEmoji(elem);
            if (emojiInfo) {
              segments.push({ type: "emoji", emoji: emojiInfo });
              plainText += emojiInfo.alt || "[emoji]";
              return;
            }
          }
          for (const child of elem.childNodes) {
            processNode(child);
          }
        }
      };
      for (const child of messageElement.childNodes) {
        processNode(child);
      }
      return {
        text: this.normalizeText(plainText),
        content: segments
      };
    }
    /**
     * Stop monitoring
     */
    stop() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      this.chatContainer = null;
      this.callback = null;
      console.log("[YT Chat Overlay] Chat monitoring stopped");
    }
    /**
     * Check if chat is active (received messages recently)
     */
    isActive() {
      const now = Date.now();
      return now - this.lastMessageTime < 3e4;
    }
  }

  class Overlay {
    container = null;
    playerElement = null;
    resizeObserver = null;
    dimensions = null;
    /**
     * Find player container
     */
    async findPlayerContainer() {
      console.log("[YT Chat Overlay] Looking for player container...");
      const match = await waitForElementMatch(PLAYER_CONTAINER_SELECTORS$1, {
        attempts: 5,
        intervalMs: 1e3,
        predicate: isVisibleElement
      });
      if (!match) {
        console.warn("[YT Chat Overlay] No player container found");
        return null;
      }
      console.log("[YT Chat Overlay] Player found with selector:", match.selector, {
        width: match.element.offsetWidth,
        height: match.element.offsetHeight
      });
      return match.element;
    }
    /**
     * Create overlay container
     */
    async create(settings) {
      this.playerElement = await this.findPlayerContainer();
      if (!this.playerElement) {
        return false;
      }
      this.container = document.createElement("div");
      this.container.id = "yt-live-chat-overlay";
      this.container.style.cssText = `
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 100;
      contain: layout style paint;
    `;
      this.playerElement.style.position = "relative";
      this.playerElement.appendChild(this.container);
      this.resizeObserver = new ResizeObserver(() => {
        this.updateDimensions(settings);
      });
      this.resizeObserver.observe(this.playerElement);
      document.addEventListener("fullscreenchange", () => {
        setTimeout(() => this.updateDimensions(settings), 100);
      });
      this.updateDimensions(settings);
      console.log("[YT Chat Overlay] Overlay created");
      return true;
    }
    /**
     * Update overlay dimensions
     */
    updateDimensions(settings) {
      if (!this.container || !this.playerElement) return;
      const width = this.playerElement.offsetWidth;
      const height = this.playerElement.offsetHeight;
      if (width === 0 || height === 0) return;
      const laneHeight = settings.fontSize * 1.6;
      const usableHeight = height * (1 - settings.safeTop - settings.safeBottom);
      const laneCount = Math.floor(usableHeight / laneHeight);
      this.dimensions = {
        width,
        height,
        laneHeight,
        laneCount: Math.max(1, laneCount)
      };
    }
    /**
     * Get current dimensions
     */
    getDimensions() {
      return this.dimensions;
    }
    /**
     * Get overlay container
     */
    getContainer() {
      return this.container;
    }
    /**
     * Destroy overlay
     */
    destroy() {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      if (this.container?.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      this.container = null;
      this.playerElement = null;
      this.dimensions = null;
      console.log("[YT Chat Overlay] Overlay destroyed");
    }
  }

  class PageWatcher {
    currentUrl;
    callbacks;
    constructor() {
      this.currentUrl = location.href;
      this.callbacks = /* @__PURE__ */ new Set();
      this.init();
    }
    /**
     * Initialize page watcher
     */
    init() {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      history.pushState = (...args) => {
        originalPushState.apply(history, args);
        this.checkUrlChange();
      };
      history.replaceState = (...args) => {
        originalReplaceState.apply(history, args);
        this.checkUrlChange();
      };
      window.addEventListener("popstate", () => {
        this.checkUrlChange();
      });
      window.addEventListener("yt-navigate-finish", () => {
        console.log("[YT Chat Overlay] YouTube navigation finished");
        this.checkUrlChange(true);
      });
      setInterval(() => {
        this.checkUrlChange();
      }, 2e3);
    }
    /**
     * Check if URL has changed
     */
    checkUrlChange(forceNotify = false) {
      const newUrl = location.href;
      if (newUrl !== this.currentUrl) {
        this.currentUrl = newUrl;
        this.notifyCallbacks();
        return;
      }
      if (forceNotify) {
        this.notifyCallbacks();
      }
    }
    /**
     * Notify all registered callbacks
     */
    notifyCallbacks() {
      for (const callback of this.callbacks) {
        try {
          callback();
        } catch (error) {
          console.error("[YT Chat Overlay] Page change callback error:", error);
        }
      }
    }
    /**
     * Register a callback for page changes
     */
    onChange(callback) {
      this.callbacks.add(callback);
    }
    /**
     * Unregister a callback
     */
    offChange(callback) {
      this.callbacks.delete(callback);
    }
    /**
     * Check if current page is a valid target (live/watch page)
     */
    isValidPage() {
      const url = this.currentUrl;
      return url.includes("/watch") || url.includes("/live/");
    }
    /**
     * Cleanup
     */
    destroy() {
      this.callbacks.clear();
    }
  }

  class Renderer {
    overlay;
    settings;
    lanes = [];
    activeMessages = /* @__PURE__ */ new Set();
    messageQueue = [];
    lastProcessTime = 0;
    processedInLastSecond = 0;
    isPaused = false;
    styleElement = null;
    constructor(overlay, settings) {
      this.overlay = overlay;
      this.settings = settings;
      this.initLanes();
      this.injectStyles();
    }
    /**
     * Initialize lanes
     */
    initLanes() {
      const dimensions = this.overlay.getDimensions();
      if (!dimensions) return;
      this.lanes = Array.from({ length: dimensions.laneCount }, (_, i) => ({
        index: i,
        lastItemExitTime: 0,
        lastItemStartTime: 0,
        lastItemWidthPx: 0
      }));
    }
    /**
     * Inject CSS animations
     */
    injectStyles() {
      if (!this.styleElement) {
        this.styleElement = document.createElement("style");
        document.head.appendChild(this.styleElement);
      }
      const textShadow = this.buildTextShadow(this.settings.outline);
      const textStroke = this.buildTextStroke(this.settings.outline);
      this.styleElement.textContent = `
      .yt-chat-overlay-message {
        position: absolute;
        white-space: nowrap;
        font-family: system-ui, -apple-system, sans-serif;
        font-weight: 700;
        text-shadow: ${textShadow};
        -webkit-text-stroke: ${textStroke};
        color: white;
        pointer-events: none;
        will-change: transform;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
        /* Better text rendering */
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      /* Emoji styling */
      .yt-chat-overlay-emoji {
        display: inline-block;
        vertical-align: text-bottom;
        margin: 0 2px;
        pointer-events: none;
        /* Match text outline */
        filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
      }

      /* Member-only emoji (special highlight) */
      .yt-chat-overlay-emoji-member {
        /* Green glow for member emojis */
        filter: drop-shadow(0 0 2px rgba(15, 157, 88, 0.6))
                drop-shadow(0 0 4px rgba(15, 157, 88, 0.4));
      }
    `;
    }
    buildTextShadow(outline) {
      if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
        return "none";
      }
      const offset = outline.widthPx;
      const blur = Math.max(0, outline.blurPx);
      const baseOpacity = Math.min(1, outline.opacity);
      const glowOpacity = Math.min(1, baseOpacity * 0.85);
      const glowStrongOpacity = Math.min(1, baseOpacity * 0.65);
      const shadowColor = `rgba(0, 0, 0, ${baseOpacity})`;
      const glowColor = `rgba(0, 0, 0, ${glowOpacity})`;
      const glowStrongColor = `rgba(0, 0, 0, ${glowStrongOpacity})`;
      const glowBlur = Math.max(1, blur * 1.5);
      const glowStrongBlur = Math.max(1, blur * 2.5);
      return [
        `-${offset}px -${offset}px ${blur}px ${shadowColor}`,
        `${offset}px -${offset}px ${blur}px ${shadowColor}`,
        `-${offset}px ${offset}px ${blur}px ${shadowColor}`,
        `${offset}px ${offset}px ${blur}px ${shadowColor}`,
        `-${offset}px 0px ${blur}px ${shadowColor}`,
        `${offset}px 0px ${blur}px ${shadowColor}`,
        `0px -${offset}px ${blur}px ${shadowColor}`,
        `0px ${offset}px ${blur}px ${shadowColor}`,
        `0px 0px ${glowBlur}px ${glowColor}`,
        `0px 0px ${glowStrongBlur}px ${glowStrongColor}`
      ].join(", ");
    }
    buildTextStroke(outline) {
      if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
        return "0 transparent";
      }
      const strokeWidth = Math.max(0.2, outline.widthPx * 0.3);
      const strokeOpacity = Math.min(1, outline.opacity * 0.7);
      return `${strokeWidth}px rgba(0, 0, 0, ${strokeOpacity})`;
    }
    /**
     * Validate image URL (security)
     * Only allow YouTube CDN domains
     * Duplicated from ChatSource for defense in depth
     */
    isValidImageUrl(url) {
      try {
        const parsed = new URL(url);
        const allowedDomains = [
          "yt3.ggpht.com",
          "yt4.ggpht.com",
          "www.gstatic.com",
          "lh3.googleusercontent.com"
        ];
        return allowedDomains.some((domain) => parsed.hostname.includes(domain));
      } catch {
        return false;
      }
    }
    /**
     * Create emoji img element with proper styling
     * SECURITY: Validates URL and creates element programmatically
     */
    createEmojiElement(emoji) {
      if (!this.isValidImageUrl(emoji.url)) {
        console.warn("[YT Chat Overlay] Invalid emoji URL:", emoji.url);
        return null;
      }
      const img = document.createElement("img");
      img.src = emoji.url;
      img.alt = emoji.alt || "";
      img.className = "yt-chat-overlay-emoji";
      img.style.display = "inline-block";
      img.style.verticalAlign = "text-bottom";
      const sizeFactor = emoji.type === "member" ? 1.4 : 1.2;
      const emojiSize = this.settings.fontSize * sizeFactor;
      img.style.height = `${emojiSize}px`;
      img.style.width = "auto";
      if (emoji.type === "member") {
        img.classList.add("yt-chat-overlay-emoji-member");
      }
      img.addEventListener(
        "error",
        () => {
          img.style.display = "none";
          console.warn("[YT Chat Overlay] Failed to load emoji:", emoji.url);
        },
        { once: true }
      );
      img.draggable = false;
      return img;
    }
    /**
     * Render mixed content (text + emoji) using DOM API
     * SECURITY: No innerHTML - creates elements programmatically
     */
    renderMixedContent(container, segments) {
      for (const segment of segments) {
        if (segment.type === "text") {
          const textNode = document.createTextNode(segment.content);
          container.appendChild(textNode);
        } else if (segment.type === "emoji") {
          const img = this.createEmojiElement(segment.emoji);
          if (img) {
            container.appendChild(img);
          }
        }
      }
    }
    /**
     * Add message to render queue
     */
    addMessage(message) {
      const now = Date.now();
      if (now - this.lastProcessTime > 1e3) {
        this.processedInLastSecond = 0;
        this.lastProcessTime = now;
      }
      if (this.processedInLastSecond >= this.settings.maxMessagesPerSecond) {
        return;
      }
      this.messageQueue.push(message);
      if (!this.isPaused) {
        this.processQueue();
      }
    }
    /**
     * Process message queue
     */
    processQueue() {
      if (this.isPaused) {
        return;
      }
      while (this.messageQueue.length > 0) {
        if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
          const oldest = Array.from(this.activeMessages)[0];
          if (oldest) {
            this.removeMessage(oldest);
          }
        }
        const message = this.messageQueue.shift();
        if (message) {
          this.renderMessage(message);
          this.processedInLastSecond++;
        }
      }
    }
    /**
     * Render a single message
     */
    renderMessage(message) {
      const container = this.overlay.getContainer();
      const dimensions = this.overlay.getDimensions();
      if (!container || !dimensions) {
        console.warn("[YT Chat Overlay] Cannot render: container or dimensions missing");
        return;
      }
      const element = document.createElement("div");
      element.className = "yt-chat-overlay-message";
      if (message.content && message.content.length > 0) {
        this.renderMixedContent(element, message.content);
      } else {
        element.textContent = message.text;
      }
      element.style.fontSize = `${this.settings.fontSize}px`;
      element.style.opacity = `${this.settings.opacity}`;
      const authorType = message.authorType || "normal";
      element.style.color = this.settings.colors[authorType];
      const lane = this.findAvailableLane();
      if (lane === null) {
        console.log("[YT Chat Overlay] No available lane, dropping message");
        return;
      }
      const laneY = dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
      element.style.top = `${laneY}px`;
      element.style.left = `${dimensions.width}px`;
      container.appendChild(element);
      const textWidth = element.offsetWidth;
      const exitPadding = Math.max(this.settings.fontSize * 2, 80);
      const distance = dimensions.width + textWidth + exitPadding;
      const duration = Math.max(
        4e3,
        Math.min(14e3, distance / this.settings.speedPxPerSec * 1e3)
      );
      const laneDelay = lane.index % 3 * 80;
      const totalDuration = duration + laneDelay;
      const animation = element.animate(
        [{ transform: "translateX(0)" }, { transform: `translateX(-${distance}px)` }],
        {
          duration,
          delay: laneDelay,
          easing: "linear",
          fill: "forwards"
        }
      );
      console.log("[YT Chat Overlay] Rendering message:", {
        text: message.text.substring(0, 20),
        author: message.author,
        authorType: message.authorType || "normal",
        color: this.settings.colors[authorType],
        lane: lane.index,
        width: textWidth,
        distance,
        duration,
        delay: laneDelay,
        totalDuration,
        dimensions
      });
      const now = Date.now();
      lane.lastItemStartTime = now + laneDelay;
      lane.lastItemExitTime = now + totalDuration;
      lane.lastItemWidthPx = textWidth;
      const timeoutId = window.setTimeout(() => {
        this.removeMessageByElement(element);
      }, totalDuration + 2e3);
      const activeMessage = {
        element,
        lane: lane.index,
        startTime: now,
        duration,
        timeoutId,
        animation
      };
      this.activeMessages.add(activeMessage);
      animation.addEventListener(
        "finish",
        () => {
          this.removeMessageByElement(element);
        },
        { once: true }
      );
    }
    /**
     * Find available lane (collision avoidance)
     */
    findAvailableLane() {
      const now = Date.now();
      const dimensions = this.overlay.getDimensions();
      if (!dimensions) return null;
      for (const lane of this.lanes) {
        if (lane.lastItemStartTime === 0) {
          return lane;
        }
        const minSafeDistance = Math.max(this.settings.fontSize * 1.2, 60);
        const requiredGapPx = Math.max(lane.lastItemWidthPx, minSafeDistance) + minSafeDistance;
        const safeTimeGap = requiredGapPx / this.settings.speedPxPerSec * 1e3;
        const timeSinceLastStart = now - lane.lastItemStartTime;
        if (timeSinceLastStart >= safeTimeGap) {
          return lane;
        }
      }
      return null;
    }
    /**
     * Remove message by element
     */
    removeMessageByElement(element) {
      const active = Array.from(this.activeMessages).find((m) => m.element === element);
      if (active) {
        this.removeMessage(active);
      }
    }
    /**
     * Remove active message
     */
    removeMessage(active) {
      if (active.element.parentNode) {
        active.element.parentNode.removeChild(active.element);
      }
      clearTimeout(active.timeoutId);
      this.activeMessages.delete(active);
    }
    /**
     * Update settings
     */
    updateSettings(settings) {
      this.settings = settings;
      this.initLanes();
      this.injectStyles();
    }
    /**
     * Pause all active animations
     */
    pause() {
      if (this.isPaused) return;
      console.log("[Renderer] Pausing all animations");
      this.isPaused = true;
      this.forEachAnimation((animation) => animation.pause());
      console.log(`[Renderer] Paused ${this.activeMessages.size} animations`);
    }
    /**
     * Resume all active animations and process queued messages
     */
    resume() {
      if (!this.isPaused) return;
      console.log("[Renderer] Resuming all animations");
      this.isPaused = false;
      this.forEachAnimation((animation) => animation.play());
      console.log(`[Renderer] Resumed ${this.activeMessages.size} animations`);
      this.processQueue();
    }
    /**
     * Check if renderer is paused
     */
    isPausedState() {
      return this.isPaused;
    }
    /**
     * Set playback rate for all active animations
     * Synchronizes animation speed with video playback rate
     */
    setPlaybackRate(rate) {
      if (rate <= 0) {
        console.warn("[Renderer] Invalid playback rate:", rate);
        return;
      }
      console.log(
        `[Renderer] Setting playback rate to ${rate}x for ${this.activeMessages.size} animations`
      );
      this.forEachAnimation((animation) => {
        animation.playbackRate = rate;
      });
    }
    /**
     * Helper method to apply an operation to all active animations
     * Centralizes animation manipulation logic
     */
    forEachAnimation(operation) {
      for (const active of this.activeMessages) {
        try {
          operation(active.animation);
        } catch (error) {
          console.warn("[Renderer] Animation operation failed:", error);
        }
      }
    }
    /**
     * Clear all messages
     */
    clear() {
      for (const active of this.activeMessages) {
        this.removeMessage(active);
      }
      this.activeMessages.clear();
      this.messageQueue = [];
    }
    /**
     * Destroy renderer
     */
    destroy() {
      this.isPaused = false;
      this.clear();
      if (this.styleElement?.parentNode) {
        this.styleElement.parentNode.removeChild(this.styleElement);
      }
      this.styleElement = null;
    }
  }

  const STORAGE_KEY = "yt-live-chat-overlay-settings";
  class Settings {
    settings;
    constructor() {
      this.settings = this.loadSettings();
    }
    /**
     * Load settings from localStorage
     */
    loadSettings() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          return {
            ...DEFAULT_SETTINGS,
            ...parsed,
            // Deep merge colors to ensure all color fields are present
            colors: {
              ...DEFAULT_SETTINGS.colors,
              ...parsed.colors || {}
            },
            // Deep merge outline to ensure all fields are present
            outline: {
              ...DEFAULT_SETTINGS.outline,
              ...parsed.outline || {}
            }
          };
        }
      } catch (error) {
        console.warn("[YT Chat Overlay] Failed to load settings:", error);
      }
      return { ...DEFAULT_SETTINGS };
    }
    /**
     * Save settings to localStorage
     */
    saveSettings() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      } catch (error) {
        console.warn("[YT Chat Overlay] Failed to save settings:", error);
      }
    }
    /**
     * Get current settings
     */
    get() {
      return { ...this.settings };
    }
    /**
     * Update settings
     */
    update(partial) {
      this.settings = {
        ...this.settings,
        ...partial,
        colors: partial.colors ? { ...this.settings.colors, ...partial.colors } : this.settings.colors,
        outline: partial.outline ? { ...this.settings.outline, ...partial.outline } : this.settings.outline
      };
      this.saveSettings();
    }
    /**
     * Reset to defaults
     */
    reset() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.saveSettings();
    }
  }

  const STYLE_ID = "yt-chat-overlay-settings-style";
  const BUTTON_ID = "yt-chat-overlay-settings-button";
  const BACKDROP_ID = "yt-chat-overlay-settings-backdrop";
  class SettingsUi {
    constructor(getSettings, updateSettings, resetSettings) {
      this.getSettings = getSettings;
      this.updateSettings = updateSettings;
      this.resetSettings = resetSettings;
    }
    playerElement = null;
    button = null;
    backdrop = null;
    modal = null;
    handleKeydown = (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    };
    async attach() {
      const player = await this.findPlayerContainer();
      if (!player) return;
      if (this.playerElement === player && this.button?.isConnected) {
        return;
      }
      this.playerElement = player;
      this.ensureButton(player);
      this.ensureModal();
      this.close();
    }
    close() {
      if (!this.backdrop) return;
      this.backdrop.style.display = "none";
      this.backdrop.hidden = true;
      document.removeEventListener("keydown", this.handleKeydown);
    }
    async findPlayerContainer() {
      const match = await waitForElementMatch(PLAYER_CONTAINER_SELECTORS$1, {
        attempts: 5,
        intervalMs: 500,
        predicate: isVisibleElement
      });
      if (!match) {
        console.warn("[YT Chat Overlay] Settings UI: player container not found");
        return null;
      }
      return match.element;
    }
    ensureButton(player) {
      if (!this.button) {
        this.button = document.createElement("button");
        this.button.id = BUTTON_ID;
        this.button.type = "button";
        this.button.className = "yt-chat-overlay-settings-button";
        this.button.textContent = "⚙";
        this.button.setAttribute("aria-label", "Chat overlay settings");
        this.button.addEventListener("click", () => this.open());
      } else if (this.button.parentElement) {
        this.button.parentElement.removeChild(this.button);
      }
      const computedStyle = window.getComputedStyle(player);
      if (computedStyle.position === "static") {
        player.style.position = "relative";
      }
      player.appendChild(this.button);
    }
    ensureModal() {
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
        .yt-chat-overlay-settings-button {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(0, 0, 0, 0.6);
          color: #fff;
          font-size: 16px;
          cursor: pointer;
          z-index: 120;
          pointer-events: auto;
        }
        .yt-chat-overlay-settings-button:hover {
          background: rgba(0, 0, 0, 0.75);
        }
        .yt-chat-overlay-settings-backdrop {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.55);
          z-index: 9999;
        }
        .yt-chat-overlay-settings-modal {
          width: 380px;
          max-height: 82vh;
          overflow: auto;
          background: rgba(20, 20, 20, 0.96);
          color: #fff;
          border-radius: 10px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          font-family: system-ui, -apple-system, sans-serif;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
        }
        .yt-chat-overlay-settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: 700;
          font-size: 16px;
        }
        .yt-chat-overlay-settings-close {
          border: none;
          background: transparent;
          color: #fff;
          font-size: 18px;
          cursor: pointer;
        }
        .yt-chat-overlay-settings-section {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .yt-chat-overlay-settings-section-title {
          font-size: 13px;
          color: rgba(255, 255, 255, 0.7);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .yt-chat-overlay-settings-field {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          font-size: 14px;
        }
        .yt-chat-overlay-settings-field input[type="number"] {
          width: 110px;
          padding: 4px 6px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(0, 0, 0, 0.4);
          color: #fff;
        }
        .yt-chat-overlay-settings-field input[type="color"] {
          width: 48px;
          height: 28px;
          border: none;
          background: transparent;
          padding: 0;
        }
        .yt-chat-overlay-settings-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding-top: 4px;
        }
        .yt-chat-overlay-settings-actions button {
          border: none;
          border-radius: 6px;
          padding: 6px 12px;
          cursor: pointer;
          font-weight: 600;
        }
        .yt-chat-overlay-settings-actions button[data-action="reset"] {
          background: rgba(255, 255, 255, 0.15);
          color: #fff;
        }
        .yt-chat-overlay-settings-actions button[data-action="apply"] {
          background: #3ea6ff;
          color: #111;
        }
      `;
        document.head.appendChild(style);
      }
      if (this.backdrop) return;
      this.backdrop = document.createElement("div");
      this.backdrop.id = BACKDROP_ID;
      this.backdrop.className = "yt-chat-overlay-settings-backdrop";
      this.backdrop.style.display = "none";
      this.backdrop.hidden = true;
      this.backdrop.addEventListener("click", (event) => {
        if (event.target === this.backdrop) {
          this.close();
        }
      });
      this.modal = document.createElement("div");
      this.modal.className = "yt-chat-overlay-settings-modal";
      this.modal.innerHTML = `
      <div class="yt-chat-overlay-settings-header">
        <div>Chat Overlay Settings</div>
        <button type="button" class="yt-chat-overlay-settings-close" aria-label="Close settings">✕</button>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">General</div>
        <label class="yt-chat-overlay-settings-field">
          <span>Enabled</span>
          <input type="checkbox" name="enabled" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Speed (px/s)</span>
          <input type="number" name="speedPxPerSec" min="120" max="500" step="5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Font size (px)</span>
          <input type="number" name="fontSize" min="16" max="48" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="opacity" min="0.4" max="1" step="0.02" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe top (%)</span>
          <input type="number" name="safeTop" min="0" max="30" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe bottom (%)</span>
          <input type="number" name="safeBottom" min="0" max="30" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Max concurrent</span>
          <input type="number" name="maxConcurrentMessages" min="5" max="60" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Max messages/s</span>
          <input type="number" name="maxMessagesPerSecond" min="1" max="20" step="1" />
        </label>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Colors</div>
        <label class="yt-chat-overlay-settings-field">
          <span>Normal</span>
          <input type="color" name="color-normal" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Member</span>
          <input type="color" name="color-member" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Moderator</span>
          <input type="color" name="color-moderator" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Owner</span>
          <input type="color" name="color-owner" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Verified</span>
          <input type="color" name="color-verified" />
        </label>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Outline</div>
        <label class="yt-chat-overlay-settings-field">
          <span>Enabled</span>
          <input type="checkbox" name="outline-enabled" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Width (px)</span>
          <input type="number" name="outline-widthPx" min="0" max="6" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Blur (px)</span>
          <input type="number" name="outline-blurPx" min="0" max="10" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="outline-opacity" min="0" max="1" step="0.05" />
        </label>
      </div>
      <div class="yt-chat-overlay-settings-actions">
        <button type="button" data-action="reset">Reset</button>
        <button type="button" data-action="apply">Apply</button>
      </div>
    `;
      this.modal.querySelector(".yt-chat-overlay-settings-close")?.addEventListener("click", () => this.close());
      this.modal.querySelector('button[data-action="apply"]')?.addEventListener("click", () => this.apply());
      this.modal.querySelector('button[data-action="reset"]')?.addEventListener("click", () => this.handleReset());
      this.backdrop.appendChild(this.modal);
      document.body.appendChild(this.backdrop);
    }
    open() {
      if (!this.backdrop) return;
      this.populateForm(this.getSettings());
      this.backdrop.style.display = "flex";
      this.backdrop.hidden = false;
      document.addEventListener("keydown", this.handleKeydown);
    }
    apply() {
      const partial = this.collectSettings();
      this.updateSettings(partial);
      this.populateForm(this.getSettings());
      this.close();
    }
    handleReset() {
      this.resetSettings();
      this.populateForm(this.getSettings());
    }
    populateForm(settings) {
      this.setCheckbox("enabled", settings.enabled);
      this.setValue("speedPxPerSec", settings.speedPxPerSec);
      this.setValue("fontSize", settings.fontSize);
      this.setValue("opacity", settings.opacity);
      this.setValue("safeTop", (settings.safeTop * 100).toFixed(1));
      this.setValue("safeBottom", (settings.safeBottom * 100).toFixed(1));
      this.setValue("maxConcurrentMessages", settings.maxConcurrentMessages);
      this.setValue("maxMessagesPerSecond", settings.maxMessagesPerSecond);
      this.setValue("color-normal", settings.colors.normal);
      this.setValue("color-member", settings.colors.member);
      this.setValue("color-moderator", settings.colors.moderator);
      this.setValue("color-owner", settings.colors.owner);
      this.setValue("color-verified", settings.colors.verified);
      this.setCheckbox("outline-enabled", settings.outline.enabled);
      this.setValue("outline-widthPx", settings.outline.widthPx);
      this.setValue("outline-blurPx", settings.outline.blurPx);
      this.setValue("outline-opacity", settings.outline.opacity);
    }
    collectSettings() {
      const current = this.getSettings();
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const readNumber = (name, fallback) => {
        const input = this.getInput(name);
        if (!input) return fallback;
        const parsed = Number.parseFloat(input.value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      return {
        enabled: this.getCheckbox("enabled", current.enabled),
        speedPxPerSec: clamp(readNumber("speedPxPerSec", current.speedPxPerSec), 120, 500),
        fontSize: clamp(readNumber("fontSize", current.fontSize), 16, 48),
        opacity: clamp(readNumber("opacity", current.opacity), 0.4, 1),
        safeTop: clamp(readNumber("safeTop", current.safeTop * 100), 0, 30) / 100,
        safeBottom: clamp(readNumber("safeBottom", current.safeBottom * 100), 0, 30) / 100,
        maxConcurrentMessages: Math.round(
          clamp(readNumber("maxConcurrentMessages", current.maxConcurrentMessages), 5, 60)
        ),
        maxMessagesPerSecond: Math.round(
          clamp(readNumber("maxMessagesPerSecond", current.maxMessagesPerSecond), 1, 20)
        ),
        colors: {
          normal: this.getColor("color-normal", current.colors.normal),
          member: this.getColor("color-member", current.colors.member),
          moderator: this.getColor("color-moderator", current.colors.moderator),
          owner: this.getColor("color-owner", current.colors.owner),
          verified: this.getColor("color-verified", current.colors.verified)
        },
        outline: {
          enabled: this.getCheckbox("outline-enabled", current.outline.enabled),
          widthPx: clamp(readNumber("outline-widthPx", current.outline.widthPx), 0, 6),
          blurPx: clamp(readNumber("outline-blurPx", current.outline.blurPx), 0, 10),
          opacity: clamp(readNumber("outline-opacity", current.outline.opacity), 0, 1)
        }
      };
    }
    getInput(name) {
      return this.modal?.querySelector(`input[name="${name}"]`) ?? null;
    }
    getCheckbox(name, fallback) {
      const input = this.getInput(name);
      return input ? input.checked : fallback;
    }
    getColor(name, fallback) {
      const input = this.getInput(name);
      return input?.value || fallback;
    }
    setValue(name, value) {
      const input = this.getInput(name);
      if (input) {
        input.value = String(value);
      }
    }
    setCheckbox(name, value) {
      const input = this.getInput(name);
      if (input) {
        input.checked = value;
      }
    }
  }

  const VIDEO_SELECTORS = [
    "#movie_player video",
    ".html5-video-player video",
    "video.html5-main-video",
    "video[src]"
  ];
  const PLAYER_CONTAINER_SELECTORS = "#movie_player, .html5-video-player";
  const CONFIG = {
    /** Number of detection attempts with delay */
    DETECTION_ATTEMPTS: 5,
    /** Delay between detection attempts (ms) */
    DETECTION_INTERVAL_MS: 500,
    /** Periodic detection interval (ms) */
    PERIODIC_DETECTION_INTERVAL_MS: 2e3,
    /** Delay before reinitializing after video replacement (ms) */
    REINITIALIZATION_DELAY_MS: 1e3,
    /** Minimum video readyState for acceptance */
    MIN_READY_STATE: 2
  };
  class VideoSync {
    videoElement = null;
    callbacks;
    initialized = false;
    detectInterval = null;
    mutationObserver = null;
    boundHandlers = {
      pause: () => this.handlePause(),
      play: () => this.handlePlay(),
      seeking: () => this.handleSeeking(),
      ratechange: () => this.handleRateChange()
    };
    constructor(callbacks) {
      this.callbacks = callbacks;
    }
    /**
     * Initialize video synchronization
     * @returns true if video element found, false if periodic detection started
     */
    async init() {
      const videoElement = await this.detectVideoElement();
      if (!videoElement) {
        console.warn("[VideoSync] Video element not found, starting periodic detection");
        this.startPeriodicDetection();
        return false;
      }
      this.setupVideoElement(videoElement);
      console.log("[VideoSync] Initialized with video element");
      return true;
    }
    /**
     * Detect video element in player container
     * Retries multiple times to handle slow page loads
     */
    async detectVideoElement() {
      const match = await waitForElementMatch(VIDEO_SELECTORS, {
        attempts: CONFIG.DETECTION_ATTEMPTS,
        intervalMs: CONFIG.DETECTION_INTERVAL_MS,
        predicate: this.isVideoReady
      });
      if (match) {
        console.log("[VideoSync] Found video element:", match.selector);
        return match.element;
      }
      return null;
    }
    /**
     * Check if video element is ready for use
     */
    isVideoReady(video) {
      return video.readyState >= CONFIG.MIN_READY_STATE && video.videoWidth > 0;
    }
    /**
     * Setup video element with listeners and observers
     */
    setupVideoElement(video) {
      this.videoElement = video;
      this.attachListeners();
      this.observeVideoReplacement();
      this.initialized = true;
    }
    /**
     * Start periodic detection for video element
     * Used when video is not immediately available (ads, live stream loading, etc.)
     */
    startPeriodicDetection() {
      if (this.detectInterval !== null) return;
      this.detectInterval = window.setInterval(() => {
        if (this.initialized) {
          this.stopPeriodicDetection();
          return;
        }
        const match = findElementMatch(VIDEO_SELECTORS, {
          predicate: this.isVideoReady
        });
        if (match) {
          this.setupVideoElement(match.element);
          this.stopPeriodicDetection();
          console.log("[VideoSync] Video element detected via periodic check:", match.selector);
        }
      }, CONFIG.PERIODIC_DETECTION_INTERVAL_MS);
      console.log("[VideoSync] Periodic detection started (every 2 seconds)");
    }
    /**
     * Stop periodic detection interval
     */
    stopPeriodicDetection() {
      if (this.detectInterval !== null) {
        window.clearInterval(this.detectInterval);
        this.detectInterval = null;
        console.log("[VideoSync] Periodic detection stopped");
      }
    }
    /**
     * Attach event listeners to video element
     */
    attachListeners() {
      if (!this.videoElement) return;
      this.videoElement.addEventListener("pause", this.boundHandlers.pause);
      this.videoElement.addEventListener("play", this.boundHandlers.play);
      this.videoElement.addEventListener("seeking", this.boundHandlers.seeking);
      this.videoElement.addEventListener("ratechange", this.boundHandlers.ratechange);
      console.log("[VideoSync] Event listeners attached");
    }
    /**
     * Detach event listeners from video element
     */
    detachListeners() {
      if (!this.videoElement) return;
      this.videoElement.removeEventListener("pause", this.boundHandlers.pause);
      this.videoElement.removeEventListener("play", this.boundHandlers.play);
      this.videoElement.removeEventListener("seeking", this.boundHandlers.seeking);
      this.videoElement.removeEventListener("ratechange", this.boundHandlers.ratechange);
      console.log("[VideoSync] Event listeners detached");
    }
    /**
     * Observe video element replacement
     * Detects when video element is removed from DOM (e.g., during ad transitions)
     */
    observeVideoReplacement() {
      if (!this.videoElement) return;
      const playerContainer = document.querySelector(PLAYER_CONTAINER_SELECTORS);
      if (!playerContainer) {
        console.warn("[VideoSync] Player container not found, cannot observe video replacement");
        return;
      }
      this.mutationObserver = new MutationObserver(() => {
        if (this.videoElement && !document.contains(this.videoElement)) {
          console.log("[VideoSync] Video element removed from DOM, reinitializing...");
          this.handleVideoReplacement();
        }
      });
      this.mutationObserver.observe(playerContainer, {
        childList: true,
        subtree: true
      });
      console.log("[VideoSync] Video replacement observer attached");
    }
    /**
     * Stop observing video replacement
     */
    stopObservingReplacement() {
      if (this.mutationObserver) {
        this.mutationObserver.disconnect();
        this.mutationObserver = null;
        console.log("[VideoSync] Video replacement observer stopped");
      }
    }
    /**
     * Handle video element replacement
     * Called when video element is removed from DOM
     */
    handleVideoReplacement() {
      this.cleanup();
      setTimeout(() => {
        console.log("[VideoSync] Attempting to reacquire video element...");
        this.init().catch((error) => {
          console.warn("[VideoSync] Failed to reinitialize after video replacement:", error);
        });
      }, CONFIG.REINITIALIZATION_DELAY_MS);
    }
    /**
     * Clean up video element state
     */
    cleanup() {
      this.detachListeners();
      this.stopObservingReplacement();
      this.videoElement = null;
      this.initialized = false;
    }
    /**
     * Event handlers
     */
    handlePause() {
      console.log("[VideoSync] Video paused");
      this.callbacks.onPause?.();
    }
    handlePlay() {
      console.log("[VideoSync] Video playing");
      this.callbacks.onPlay?.();
    }
    handleSeeking() {
      console.log("[VideoSync] Video seeking");
      this.callbacks.onSeeking?.();
    }
    handleRateChange() {
      const rate = this.videoElement?.playbackRate ?? 1;
      console.log("[VideoSync] Playback rate changed:", rate);
      this.callbacks.onRateChange?.(rate);
    }
    /**
     * Public API
     */
    /**
     * Check if video is currently paused
     * @returns true if paused or video not found, false if playing
     */
    isPaused() {
      return this.videoElement?.paused ?? true;
    }
    /**
     * Get current playback rate
     * @returns playback rate (1.0 = normal speed), defaults to 1.0 if no video
     */
    getPlaybackRate() {
      return this.videoElement?.playbackRate ?? 1;
    }
    /**
     * Check if video sync is initialized
     */
    isInitialized() {
      return this.initialized;
    }
    /**
     * Destroy and cleanup all resources
     */
    destroy() {
      this.stopPeriodicDetection();
      this.cleanup();
      console.log("[VideoSync] Destroyed");
    }
  }

  class App {
    pageWatcher;
    settings;
    chatSource = null;
    overlay = null;
    _renderer = null;
    videoSync = null;
    settingsUi;
    isInitialized = false;
    restartTimer = null;
    restartInProgress = false;
    pendingRestart = false;
    lastStartedUrl = null;
    constructor() {
      this.pageWatcher = new PageWatcher();
      this.settings = new Settings();
      this.settingsUi = new SettingsUi(
        () => this.settings.get(),
        (partial) => this.updateSettings(partial),
        () => this.resetSettings()
      );
      this.pageWatcher.onChange(() => {
        this.handlePageChange();
      });
      console.log("[YT Chat Overlay] Application initialized");
    }
    /**
     * Start application
     */
    async start() {
      if (!this.pageWatcher.isValidPage()) {
        console.log("[YT Chat Overlay] Not on a video page, waiting...");
        return;
      }
      await this.ensureSettingsUi();
      if (this.isInitialized) {
        console.log("[YT Chat Overlay] Already initialized");
        return;
      }
      const currentSettings = this.settings.get();
      if (!currentSettings.enabled) {
        console.log("[YT Chat Overlay] Overlay is disabled");
        return;
      }
      try {
        this.overlay = new Overlay();
        const overlayCreated = await this.overlay.create(currentSettings);
        if (!overlayCreated) {
          console.warn("[YT Chat Overlay] Failed to create overlay");
          this.cleanup();
          return;
        }
        this._renderer = new Renderer(this.overlay, currentSettings);
        this.videoSync = new VideoSync({
          onPause: () => {
            if (this._renderer) {
              this._renderer.pause();
            }
          },
          onPlay: () => {
            if (this._renderer) {
              this._renderer.resume();
            }
          },
          onSeeking: () => {
          },
          onRateChange: (rate) => {
            console.log("[App] Video playback rate changed:", rate);
            if (this._renderer) {
              this._renderer.setPlaybackRate(rate);
            }
          }
        });
        await this.videoSync.init();
        this.chatSource = new ChatSource();
        const chatStarted = await this.chatSource.start((message) => {
          if (this._renderer) {
            this._renderer.addMessage(message);
          }
        });
        if (!chatStarted) {
          console.warn("[YT Chat Overlay] Failed to start chat monitoring");
          this.cleanup();
          return;
        }
        this.isInitialized = true;
        this.lastStartedUrl = location.href;
        console.log("[YT Chat Overlay] Started successfully");
      } catch (error) {
        console.error("[YT Chat Overlay] Initialization error:", error);
        this.cleanup();
      }
    }
    /**
     * Handle page change (SPA navigation)
     */
    handlePageChange() {
      if (this.restartInProgress) {
        this.pendingRestart = true;
        return;
      }
      if (this.restartTimer !== null) {
        window.clearTimeout(this.restartTimer);
      }
      this.restartTimer = window.setTimeout(() => {
        this.restartTimer = null;
        void this.restartAfterNavigation();
      }, 500);
    }
    /**
     * Restart after navigation settles
     */
    async restartAfterNavigation() {
      if (this.restartInProgress) {
        this.pendingRestart = true;
        return;
      }
      this.restartInProgress = true;
      this.pendingRestart = false;
      try {
        const currentUrl = location.href;
        if (this.isInitialized && this.lastStartedUrl === currentUrl) {
          console.log("[YT Chat Overlay] Navigation event on same URL, skipping restart");
          return;
        }
        console.log("[YT Chat Overlay] Page changed, cleaning up and restarting...");
        this.cleanup();
        await sleep(2e3);
        if (!this.pageWatcher.isValidPage()) {
          console.log("[YT Chat Overlay] Not on a valid page after navigation");
          return;
        }
        if (!this.settings.get().enabled) {
          console.log("[YT Chat Overlay] Overlay is disabled, not restarting");
          return;
        }
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          console.log(`[YT Chat Overlay] Restart attempt ${attempt}/${maxRetries}`);
          try {
            await this.start();
            if (this.isInitialized) {
              console.log("[YT Chat Overlay] Successfully restarted after navigation");
              return;
            }
          } catch (error) {
            console.warn(`[YT Chat Overlay] Restart attempt ${attempt} failed:`, error);
          }
          if (attempt < maxRetries) {
            await sleep(2e3);
          }
        }
        console.warn("[YT Chat Overlay] Failed to restart after all retry attempts");
      } catch (error) {
        console.warn("[YT Chat Overlay] Restart error:", error);
      } finally {
        this.restartInProgress = false;
        if (this.pendingRestart) {
          this.pendingRestart = false;
          this.handlePageChange();
        }
      }
    }
    /**
     * Get current settings
     */
    getSettings() {
      return this.settings.get();
    }
    /**
     * Update settings (for console access)
     */
    updateSettings(partial) {
      const wasEnabled = this.settings.get().enabled;
      this.settings.update(partial);
      const nextSettings = this.settings.get();
      if (wasEnabled && !nextSettings.enabled) {
        this.cleanup();
        console.log("[YT Chat Overlay] Overlay disabled");
        return;
      }
      if (!wasEnabled && nextSettings.enabled) {
        void this.start();
        console.log("[YT Chat Overlay] Overlay enabled");
        return;
      }
      const currentOverlay = this.overlay;
      const needsOverlayRefresh = currentOverlay && (partial.safeTop !== void 0 || partial.safeBottom !== void 0 || partial.fontSize !== void 0);
      if (needsOverlayRefresh) {
        if (this._renderer) {
          this._renderer.destroy();
          this._renderer = null;
        }
        currentOverlay.destroy();
        this.overlay = new Overlay();
        this.overlay.create(nextSettings).then((created) => {
          if (!created) {
            console.warn("[YT Chat Overlay] Failed to recreate overlay");
            return;
          }
          const overlay = this.overlay;
          if (!overlay) return;
          this._renderer = new Renderer(overlay, nextSettings);
        }).catch((error) => {
          console.error("[YT Chat Overlay] Failed to recreate overlay:", error);
        });
      } else if (this._renderer) {
        this._renderer.updateSettings(nextSettings);
      }
      console.log("[YT Chat Overlay] Settings updated:", nextSettings);
    }
    resetSettings() {
      this.updateSettings(DEFAULT_SETTINGS);
    }
    /**
     * Public access to renderer for manual testing
     */
    get renderer() {
      return this._renderer;
    }
    /**
     * Cleanup all components
     */
    cleanup() {
      console.log("[YT Chat Overlay] Starting cleanup...");
      this.settingsUi.close();
      if (this.chatSource) {
        try {
          this.chatSource.stop();
        } catch (error) {
          console.warn("[YT Chat Overlay] Error stopping chat source:", error);
        }
        this.chatSource = null;
      }
      if (this.videoSync) {
        try {
          this.videoSync.destroy();
        } catch (error) {
          console.warn("[YT Chat Overlay] Error destroying video sync:", error);
        }
        this.videoSync = null;
      }
      if (this._renderer) {
        try {
          this._renderer.destroy();
        } catch (error) {
          console.warn("[YT Chat Overlay] Error destroying renderer:", error);
        }
        this._renderer = null;
      }
      if (this.overlay) {
        try {
          this.overlay.destroy();
        } catch (error) {
          console.warn("[YT Chat Overlay] Error destroying overlay:", error);
        }
        this.overlay = null;
      }
      try {
        const leftoverOverlays = document.querySelectorAll("#yt-live-chat-overlay");
        for (const element of leftoverOverlays) {
          element.remove();
          console.log("[YT Chat Overlay] Removed leftover overlay element");
        }
      } catch (error) {
        console.warn("[YT Chat Overlay] Error removing leftover elements:", error);
      }
      this.isInitialized = false;
      console.log("[YT Chat Overlay] Cleanup completed");
    }
    /**
     * Stop application
     */
    stop() {
      this.cleanup();
      this.pageWatcher.destroy();
    }
    async ensureSettingsUi() {
      try {
        await this.settingsUi.attach();
      } catch (error) {
        console.warn("[YT Chat Overlay] Settings UI error:", error);
      }
    }
  }
  function main() {
    console.log("[YT Chat Overlay] Script loaded", {
      readyState: document.readyState,
      url: location.href
    });
    if (document.readyState === "loading") {
      console.log("[YT Chat Overlay] Waiting for DOMContentLoaded...");
      document.addEventListener("DOMContentLoaded", () => {
        console.log("[YT Chat Overlay] DOMContentLoaded fired");
        setTimeout(() => initApp(), 500);
      });
    } else {
      console.log("[YT Chat Overlay] Document already ready, initializing...");
      setTimeout(() => initApp(), 500);
    }
  }
  async function initApp() {
    console.log("[YT Chat Overlay] Initializing application...");
    try {
      const app = new App();
      await app.start();
      window.__ytChatOverlay = app;
      console.log("[YT Chat Overlay] App instance exposed to window.__ytChatOverlay");
    } catch (error) {
      console.error("[YT Chat Overlay] Fatal error:", error);
      throw error;
    }
  }
  try {
    main();
  } catch (error) {
    console.error("[YT Chat Overlay] Failed to start:", error);
  }

})();
