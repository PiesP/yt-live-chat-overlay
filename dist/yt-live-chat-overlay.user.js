// ==UserScript==
// @name         YouTube Live Chat Overlay
// @version      0.4.0
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
    speedPxPerSec: 200,
    // Slightly slower for better readability with multi-line messages
    fontSize: 24,
    // Slightly smaller for better space utilization
    opacity: 0.95,
    // Slightly more opaque for better visibility
    superChatOpacity: 0.4,
    // Higher default opacity for stronger Super Chat colors
    safeTop: 0.1,
    // 10% - increased for better clearance from top UI elements
    safeBottom: 0.12,
    // 12% - reduced since we handle multi-line messages better
    maxConcurrentMessages: 50,
    // Soft cap for performance monitoring (not enforced)
    maxMessagesPerSecond: 10,
    // Rate limit for incoming messages (enforced)
    showAuthor: {
      normal: false,
      member: false,
      moderator: true,
      owner: true,
      verified: false,
      superChat: true
    },
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
      widthPx: 1.5,
      // Slightly thicker for better contrast
      blurPx: 2,
      // Increased blur for better glow effect
      opacity: 0.7
      // Increased opacity for better visibility
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
        const authorType = this.extractAuthorType(element);
        const authorName = this.extractAuthorName(element);
        const authorPhotoUrl = this.extractAuthorPhotoUrl(element);
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
        if (authorPhotoUrl) {
          message.authorPhotoUrl = authorPhotoUrl;
        }
        if (kind === "superchat") {
          const superChatInfo = this.parseSuperChatInfo(element);
          if (superChatInfo) {
            message.superChat = superChatInfo;
          }
        }
        if (kind !== "text" && kind !== "superchat") return null;
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
     * Extract author photo URL
     */
    extractAuthorPhotoUrl(element) {
      const authorPhotoElement = element.querySelector(
        "#author-photo img, yt-live-chat-author-chip #author-photo img, #img"
      );
      if (!authorPhotoElement) {
        return void 0;
      }
      const photoUrl = authorPhotoElement.src || authorPhotoElement.getAttribute("src");
      if (!photoUrl) {
        return void 0;
      }
      if (!this.isValidImageUrl(photoUrl)) {
        console.warn("[YT Chat Overlay] Invalid author photo URL:", photoUrl);
        return void 0;
      }
      return photoUrl;
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
     * Parse Super Chat information from element
     */
    parseSuperChatInfo(element) {
      try {
        const purchaseAmountElement = element.querySelector(
          "#purchase-amount, yt-formatted-string#purchase-amount"
        );
        const amountText = purchaseAmountElement?.textContent?.trim() || "";
        if (!amountText) {
          console.warn("[YT Chat Overlay] Super Chat detected but no amount found");
          return null;
        }
        const currencyMatch = amountText.match(/[A-Z]{3}/) || [];
        const currency = currencyMatch[0];
        const computedStyle = window.getComputedStyle(element);
        const backgroundColor = computedStyle.backgroundColor || element.getAttribute("style")?.match(/background-color:\s*([^;]+)/)?.[1] || void 0;
        const headerElement = element.querySelector(
          "#card, #header, yt-live-chat-paid-message-renderer #card"
        );
        const headerBackgroundColor = headerElement ? window.getComputedStyle(headerElement).backgroundColor || void 0 : void 0;
        const tier = this.determineSuperChatTier(backgroundColor, amountText);
        const stickerImg = element.querySelector(
          '#sticker img, yt-img-shadow#sticker img, img[id*="sticker"]'
        );
        const stickerUrl = stickerImg && this.isValidImageUrl(stickerImg.src) ? stickerImg.src : void 0;
        const superChatInfo = {
          amount: amountText,
          tier
        };
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
        console.warn("[YT Chat Overlay] Failed to parse Super Chat info:", error);
        return null;
      }
    }
    /**
     * Determine Super Chat tier based on background color or amount
     * YouTube uses different colors for different price tiers
     */
    determineSuperChatTier(backgroundColor, amountText) {
      if (!backgroundColor) {
        const numericAmount = parseFloat(amountText.replace(/[^0-9.]/g, ""));
        if (numericAmount >= 100) return "red";
        if (numericAmount >= 50) return "magenta";
        if (numericAmount >= 20) return "orange";
        if (numericAmount >= 10) return "yellow";
        if (numericAmount >= 5) return "green";
        if (numericAmount >= 2) return "cyan";
        return "blue";
      }
      const rgbMatch = backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!rgbMatch) return "blue";
      const r = parseInt(rgbMatch[1] || "0", 10);
      const g = parseInt(rgbMatch[2] || "0", 10);
      const b = parseInt(rgbMatch[3] || "0", 10);
      if (r > 200 && g < 100 && b < 100) return "red";
      if (r > 200 && g < 100 && b > 80) return "magenta";
      if (r > 200 && g > 100 && g < 150 && b < 50) return "orange";
      if (r > 200 && g > 180 && b < 100) return "yellow";
      if (r < 100 && g > 200 && b > 150) return "green";
      if (r < 100 && g > 150 && b > 200) return "cyan";
      return "blue";
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
      const baseLaneHeight = settings.fontSize * 1.3;
      const usableHeight = height * (1 - settings.safeTop - settings.safeBottom);
      const laneCount = Math.floor(usableHeight / baseLaneHeight);
      this.dimensions = {
        width,
        height,
        laneHeight: baseLaneHeight,
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

  const colors = {
    // Author type colors
    author: {
      // Verified users
      member: "#0f9d58"},
    // Super Chat tier colors
    superChat: {
      blue: { r: 30, g: 136, b: 229 },
      // Tier 1
      cyan: { r: 29, g: 233, b: 182 },
      // Tier 2
      green: { r: 0, g: 229, b: 255 },
      // Tier 3
      yellow: { r: 255, g: 202, b: 40 },
      // Tier 4
      orange: { r: 245, g: 124, b: 0 },
      // Tier 5
      magenta: { r: 233, g: 30, b: 99 },
      // Tier 6
      red: { r: 230, g: 33, b: 23 }
      // Tier 7
    },
    // UI colors
    ui: {
      background: "#1a1a1a",
      backgroundLight: "#222222",
      border: "#444444",
      text: "#ffffff",
      textMuted: "#cccccc",
      primary: "#1e88e5",
      danger: "#e53935"
    }};
  const spacing = {
    xs: 4,
    // 4px
    sm: 8,
    // 8px
    md: 12,
    // 12px
    lg: 16,
    // 24px
    xxxl: 32
    // 32px
  };
  const typography = {
    fontSize: {
      xs: "12px",
      sm: "14px",
      base: "16px",
      lg: "18px"},
    fontWeight: {
      normal: 400,
      semibold: 600,
      bold: 700
    },
    lineHeight: {
      normal: 1.5}
  };
  const shadows = {
    text: {
      sm: "1px 1px 2px rgba(0, 0, 0, 0.8)",
      md: "2px 2px 4px rgba(0, 0, 0, 0.8)"},
    box: {
      sm: "0 2px 8px rgba(0, 0, 0, 0.6)",
      md: "0 4px 16px rgba(0, 0, 0, 0.8)",
      lg: "0 8px 24px rgba(0, 0, 0, 0.9)"
    },
    filter: {
      md: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.8))"}
  };
  const borderRadius = {
    sm: "6px",
    md: "8px",
    lg: "12px",
    full: "50%"
  };
  const zIndex = {
    modal: 10003
  };
  function rgba(color, alpha) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
  }

  const LAYOUT = {
    // Author display
    AUTHOR_PHOTO_SIZE: 24,
    // px
    AUTHOR_FONT_SCALE: 0.85,
    // relative to base fontSize
    // Emoji sizing
    EMOJI_SIZE_STANDARD: 1.2,
    // relative to base fontSize
    EMOJI_SIZE_MEMBER: 1.4,
    // relative to base fontSize
    // Super Chat
    SUPERCHAT_STICKER_SIZE: 2,
    // relative to base fontSize
    // Animation
    EXIT_PADDING_MIN: 100,
    // px
    EXIT_PADDING_SCALE: 3,
    // relative to fontSize
    DURATION_MIN: 5e3,
    // ms
    DURATION_MAX: 12e3,
    // ms
    LANE_DELAY_CYCLE: 3,
    // number of lanes before repeating delay pattern
    LANE_DELAY_MS: 40,
    // ms per lane cycle
    // Collision detection
    SAFE_DISTANCE_SCALE: 0.7,
    // relative to fontSize
    SAFE_DISTANCE_MIN: 16,
    // px
    VERTICAL_CLEAR_TIME_MIN: 120,
    // ms
    VERTICAL_CLEAR_TIME_MAX: 320,
    // ms
    LANE_HEIGHT_PADDING_SCALE: 0.06,
    // relative to fontSize
    LANE_HEIGHT_PADDING_MIN: 1,
    // px
    RETRY_DELAY_MIN_MS: 16,
    // ms
    RETRY_DELAY_MAX_MS: 800,
    // ms
    QUEUE_LOOKAHEAD_LIMIT: 14
    // queue scan window for scheduling
  };
  class Renderer {
    overlay;
    settings;
    lanes = [];
    activeMessages = /* @__PURE__ */ new Set();
    messageQueue = [];
    lastProcessTime = 0;
    processedInLastSecond = 0;
    isPaused = false;
    pausedAt = null;
    playbackRate = 1;
    lastWarningTime = 0;
    WARNING_INTERVAL_MS = 1e4;
    styleElement = null;
    retryTimer = null;
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
        lastItemWidthPx: 0,
        lastItemHeightPx: 0
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
      const superChatBaseOpacity = Math.min(1, Math.max(0.4, this.settings.superChatOpacity));
      const superChatTopOpacity = Math.min(1, superChatBaseOpacity + 0.06);
      const superChatBottomOpacity = Math.max(0.4, superChatBaseOpacity - 0.08);
      this.styleElement.textContent = `
      .yt-chat-overlay-message {
        position: absolute;
        white-space: nowrap;
        font-family: system-ui, -apple-system, sans-serif;
        font-weight: ${typography.fontWeight.bold};
        text-shadow: ${textShadow};
        -webkit-text-stroke: ${textStroke};
        color: ${colors.ui.text};
        pointer-events: none;
        will-change: transform;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
        /* Better text rendering */
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      /* Message with author display */
      .yt-chat-overlay-message-with-author {
        display: flex;
        flex-direction: column;
        gap: ${spacing.xs}px;
      }

      /* Author info line */
      .yt-chat-overlay-author-info {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
        font-size: ${LAYOUT.AUTHOR_FONT_SCALE}em;
        opacity: 0.95;
      }

      /* Author photo */
      .yt-chat-overlay-author-photo {
        width: ${LAYOUT.AUTHOR_PHOTO_SIZE}px;
        height: ${LAYOUT.AUTHOR_PHOTO_SIZE}px;
        border-radius: ${borderRadius.full};
        flex-shrink: 0;
        box-shadow: ${shadows.box.sm};
        filter: ${shadows.filter.md};
      }

      /* Author name */
      .yt-chat-overlay-author-name {
        font-weight: ${typography.fontWeight.semibold};
      }

      /* Message content line */
      .yt-chat-overlay-message-content {
        display: block;
      }

      /* === Unified Super Chat Card === */

      .yt-chat-overlay-superchat-card {
        --yt-sc-rgb: 30, 136, 229;
        --yt-sc-border-rgb: 18, 92, 156;
        display: flex;
        flex-direction: column;
        min-width: min(420px, 72vw);
        max-width: min(640px, 86vw);
        border-radius: ${borderRadius.md};
        overflow: hidden;
        border: 1px solid rgba(var(--yt-sc-border-rgb), 0.55);
        background-color: rgb(30, 136, 229);
        background: linear-gradient(
          180deg,
          rgba(var(--yt-sc-rgb), ${superChatTopOpacity}) 0%,
          rgba(var(--yt-sc-rgb), ${superChatBaseOpacity}) 48%,
          rgba(var(--yt-sc-rgb), ${superChatBottomOpacity}) 100%
        );
        box-shadow: ${shadows.box.md};
        backdrop-filter: blur(4px);
      }

      .yt-chat-overlay-superchat-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: ${spacing.md}px;
        padding: ${spacing.sm}px ${spacing.md}px;
        background: rgba(0, 0, 0, 0.12);
        border-bottom: 1px solid rgba(255, 255, 255, 0.14);
      }

      .yt-chat-overlay-superchat-author {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
        min-width: 0;
      }

      .yt-chat-overlay-superchat-author .yt-chat-overlay-author-name {
        font-size: 0.88em;
        font-weight: ${typography.fontWeight.bold};
        text-shadow: ${shadows.text.sm};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .yt-chat-overlay-superchat-amount {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        padding: ${spacing.xs}px ${spacing.md}px;
        border-radius: ${borderRadius.lg};
        font-weight: ${typography.fontWeight.bold};
        font-size: 0.85em;
        letter-spacing: 0.2px;
        color: ${colors.ui.text};
        background: rgba(255, 255, 255, 0.16);
        border: 1px solid rgba(255, 255, 255, 0.22);
        text-shadow: ${shadows.text.sm};
      }

      .yt-chat-overlay-superchat-body {
        display: flex;
        flex-direction: column;
        padding: ${spacing.sm}px ${spacing.md}px ${spacing.md}px;
        gap: ${spacing.sm}px;
      }

      .yt-chat-overlay-superchat-body .yt-chat-overlay-message-content {
        line-height: ${typography.lineHeight.normal};
        text-shadow: ${shadows.text.md};
        letter-spacing: 0.2px;
        white-space: normal;
      }

      .yt-chat-overlay-superchat-body .yt-chat-overlay-superchat-sticker {
        align-self: flex-start;
        margin-bottom: ${spacing.xs}px;
      }

      /* Enhanced regular message with author */
      .yt-chat-overlay-message-with-author:not(.yt-chat-overlay-superchat-card) {
        background: rgba(0, 0, 0, 0.25);
        padding: ${spacing.sm}px ${spacing.md}px;
        border-radius: ${borderRadius.sm};
        backdrop-filter: blur(2px);
      }

      .yt-chat-overlay-message-with-author .yt-chat-overlay-author-photo {
        box-shadow: ${shadows.box.sm};
        border: 1px solid rgba(255, 255, 255, 0.15);
      }

      /* Improved text shadow for all messages */
      .yt-chat-overlay-message:not(.yt-chat-overlay-superchat-card) {
        text-shadow: ${shadows.text.md}, 0 0 8px rgba(0, 0, 0, 0.7);
        letter-spacing: 0.3px;
      }

      /* Super Chat sticker */
      .yt-chat-overlay-superchat-sticker {
        display: inline-block;
        vertical-align: middle;
        margin-right: ${spacing.sm}px;
        filter: ${shadows.filter.md};
      }

      /* Legacy styles removed - now using unified card-based system */

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

      /* === MEMBERSHIP MESSAGE CARDS === */

      /* Membership card container */
      .yt-chat-overlay-membership-card {
        display: flex;
        flex-direction: column;
        padding: ${spacing.md}px ${spacing.lg}px;
        border-radius: ${borderRadius.md};
        background: ${rgba(colors.superChat.green, 0.25)};
        border: 2px solid ${rgba(colors.superChat.green, 0.5)};
        box-shadow: ${shadows.box.md};
        backdrop-filter: blur(4px);
      }

      /* Membership author section */
      .yt-chat-overlay-membership-author {
        display: flex;
        align-items: center;
        gap: ${spacing.md}px;
      }

      /* Membership text container */
      .yt-chat-overlay-membership-text {
        display: flex;
        flex-direction: column;
        gap: ${spacing.xs}px;
      }

      /* Membership author name */
      .yt-chat-overlay-membership-author-name {
        font-size: ${typography.fontSize.base};
        font-weight: ${typography.fontWeight.bold};
        text-shadow: ${shadows.text.md};
      }

      /* Membership message text */
      .yt-chat-overlay-membership-message {
        font-size: ${typography.fontSize.sm};
        font-weight: ${typography.fontWeight.normal};
        color: ${colors.ui.text};
        text-shadow: ${shadows.text.sm};
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
     * Create a validated image element with error handling
     * Common helper for emoji, stickers, and author photos
     * SECURITY: Validates URL and creates element programmatically
     */
    createImageElement(url, alt, className, sizePx) {
      if (!this.isValidImageUrl(url)) {
        console.warn("[YT Chat Overlay] Invalid image URL:", url);
        return null;
      }
      const img = document.createElement("img");
      img.src = url;
      img.alt = alt;
      img.className = className;
      img.style.height = `${sizePx}px`;
      img.style.width = "auto";
      img.draggable = false;
      img.addEventListener(
        "error",
        () => {
          img.style.display = "none";
          console.warn("[YT Chat Overlay] Failed to load image:", url);
        },
        { once: true }
      );
      return img;
    }
    /**
     * Create a standardized author photo element
     */
    createAuthorPhotoElement(photoUrl, alt) {
      if (!photoUrl) {
        return null;
      }
      return this.createImageElement(
        photoUrl,
        alt,
        "yt-chat-overlay-author-photo",
        LAYOUT.AUTHOR_PHOTO_SIZE
      );
    }
    /**
     * Create message text element (plain text or rich text + emoji)
     */
    createMessageTextElement(message, className = "yt-chat-overlay-message-content") {
      const hasRichContent = Boolean(message.content && message.content.length > 0);
      const hasPlainText = message.text.trim().length > 0;
      if (!hasRichContent && !hasPlainText) {
        return null;
      }
      const contentDiv = document.createElement("div");
      contentDiv.className = className;
      if (hasRichContent && message.content) {
        this.renderMixedContent(contentDiv, message.content);
      } else {
        contentDiv.textContent = message.text;
      }
      return contentDiv;
    }
    /**
     * Parse RGB/RGBA color string to components
     * Handles formats: "rgb(r, g, b)" or "rgba(r, g, b, a)"
     */
    parseRgbaColor(colorString) {
      const rgbaMatch = colorString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!rgbaMatch) return null;
      return {
        r: parseInt(rgbaMatch[1] || "0", 10),
        g: parseInt(rgbaMatch[2] || "0", 10),
        b: parseInt(rgbaMatch[3] || "0", 10),
        a: rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1
      };
    }
    /**
     * Resolve Super Chat RGB color from actual YouTube color or tier fallback
     */
    resolveSuperChatRgb(superChat) {
      const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
      const parsed = sourceColor ? this.parseRgbaColor(sourceColor) : null;
      if (parsed) {
        return { r: parsed.r, g: parsed.g, b: parsed.b };
      }
      return colors.superChat[superChat.tier];
    }
    /**
     * Create emoji img element with proper styling
     * SECURITY: Validates URL and creates element programmatically
     */
    createEmojiElement(emoji) {
      const sizeFactor = emoji.type === "member" ? LAYOUT.EMOJI_SIZE_MEMBER : LAYOUT.EMOJI_SIZE_STANDARD;
      const emojiSize = this.settings.fontSize * sizeFactor;
      const img = this.createImageElement(
        emoji.url,
        emoji.alt || "",
        "yt-chat-overlay-emoji",
        emojiSize
      );
      if (!img) return null;
      img.style.display = "inline-block";
      img.style.verticalAlign = "text-bottom";
      if (emoji.type === "member") {
        img.classList.add("yt-chat-overlay-emoji-member");
      }
      return img;
    }
    /**
     * Create Super Chat sticker image element
     * SECURITY: Validates URL and creates element programmatically
     */
    createSuperChatSticker(stickerUrl) {
      const stickerSize = this.settings.fontSize * LAYOUT.SUPERCHAT_STICKER_SIZE;
      return this.createImageElement(
        stickerUrl,
        "Super Chat Sticker",
        "yt-chat-overlay-superchat-sticker",
        stickerSize
      );
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
     * Determine if author should be shown for a message
     */
    shouldShowAuthor(message) {
      const settings = this.settings.showAuthor;
      const authorType = message.authorType || "normal";
      return settings[authorType] || false;
    }
    /**
     * Create author info element (photo + name)
     * SECURITY: Validates photo URL and creates elements programmatically
     */
    createAuthorElement(message) {
      const authorInfoDiv = document.createElement("div");
      authorInfoDiv.className = "yt-chat-overlay-author-info";
      const photoImg = this.createAuthorPhotoElement(
        message.authorPhotoUrl,
        message.author || "Author"
      );
      if (photoImg) {
        authorInfoDiv.appendChild(photoImg);
      }
      if (message.author) {
        const nameSpan = document.createElement("span");
        nameSpan.className = "yt-chat-overlay-author-name";
        nameSpan.textContent = message.author;
        const authorType = message.authorType || "normal";
        nameSpan.style.color = this.settings.colors[authorType];
        authorInfoDiv.appendChild(nameSpan);
      }
      return authorInfoDiv;
    }
    /**
     * Create Super Chat header section with author info and amount badge
     */
    createSuperChatHeader(message, superChat, showAuthor) {
      const header = document.createElement("div");
      header.className = "yt-chat-overlay-superchat-meta";
      if (showAuthor) {
        const authorSection = document.createElement("div");
        authorSection.className = "yt-chat-overlay-superchat-author";
        const photoImg = this.createAuthorPhotoElement(
          message.authorPhotoUrl,
          message.author || "Author"
        );
        if (photoImg) {
          authorSection.appendChild(photoImg);
        }
        if (message.author) {
          const authorName = document.createElement("span");
          authorName.className = "yt-chat-overlay-author-name";
          authorName.textContent = message.author;
          const authorType = message.authorType || "normal";
          authorName.style.color = this.settings.colors[authorType];
          authorSection.appendChild(authorName);
        }
        if (authorSection.childElementCount > 0) {
          header.appendChild(authorSection);
        }
      }
      const amountBadge = document.createElement("span");
      amountBadge.className = "yt-chat-overlay-superchat-amount";
      amountBadge.textContent = superChat.amount;
      header.appendChild(amountBadge);
      if (!showAuthor) {
        header.style.justifyContent = "flex-end";
      }
      return header;
    }
    /**
     * Create Super Chat content section with sticker and message
     */
    createSuperChatContent(message, superChat) {
      const hasSticker = Boolean(superChat.stickerUrl);
      const messageDiv = this.createMessageTextElement(message);
      if (!messageDiv && !hasSticker) {
        return null;
      }
      const content = document.createElement("div");
      content.className = "yt-chat-overlay-superchat-body";
      if (superChat.stickerUrl) {
        const stickerImg = this.createSuperChatSticker(superChat.stickerUrl);
        if (stickerImg) {
          content.appendChild(stickerImg);
        }
      }
      if (messageDiv) {
        content.appendChild(messageDiv);
      }
      return content;
    }
    /**
     * Create membership message card with author and message
     */
    createMembershipCard(message) {
      const card = document.createElement("div");
      card.className = "yt-chat-overlay-membership-card";
      const authorSection = document.createElement("div");
      authorSection.className = "yt-chat-overlay-membership-author";
      const photo = this.createAuthorPhotoElement(message.authorPhotoUrl, message.author || "Member");
      if (photo) {
        authorSection.appendChild(photo);
      }
      const textContainer = document.createElement("div");
      textContainer.className = "yt-chat-overlay-membership-text";
      if (message.author) {
        const authorName = document.createElement("div");
        authorName.className = "yt-chat-overlay-membership-author-name";
        authorName.style.color = colors.author.member;
        authorName.textContent = message.author;
        textContainer.appendChild(authorName);
      }
      const membershipText = this.createMessageTextElement(
        message,
        "yt-chat-overlay-membership-message"
      );
      if (membershipText) {
        textContainer.appendChild(membershipText);
      }
      authorSection.appendChild(textContainer);
      card.appendChild(authorSection);
      return card;
    }
    /**
     * Apply Super Chat card styling with color variables
     */
    applySuperChatStyling(element, superChat) {
      element.classList.add("yt-chat-overlay-superchat-card");
      const rgb = this.resolveSuperChatRgb(superChat);
      const borderRgb = {
        r: Math.max(0, rgb.r - 36),
        g: Math.max(0, rgb.g - 36),
        b: Math.max(0, rgb.b - 36)
      };
      element.style.setProperty("--yt-sc-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      element.style.setProperty(
        "--yt-sc-border-rgb",
        `${borderRgb.r}, ${borderRgb.g}, ${borderRgb.b}`
      );
    }
    /**
     * Setup animation and positioning for a message element
     * Returns ActiveMessage object for tracking
     */
    setupMessageAnimation(element, placement, textWidth, messageHeight, dimensions) {
      const fontSize = this.settings.fontSize;
      const { lane, laneSpan } = placement;
      const laneY = dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
      element.style.top = `${laneY}px`;
      element.style.visibility = "visible";
      const exitPadding = Math.max(fontSize * LAYOUT.EXIT_PADDING_SCALE, LAYOUT.EXIT_PADDING_MIN);
      const distance = dimensions.width + textWidth + exitPadding;
      const effectiveSpeedPxPerSec = this.getEffectiveSpeedPxPerSec();
      const duration = Math.max(
        LAYOUT.DURATION_MIN,
        Math.min(LAYOUT.DURATION_MAX, distance / effectiveSpeedPxPerSec * 1e3)
      );
      const laneDelay = lane.index % LAYOUT.LANE_DELAY_CYCLE * LAYOUT.LANE_DELAY_MS;
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
      animation.playbackRate = this.playbackRate;
      const now = Date.now();
      const startTime = now + laneDelay;
      const exitTime = now + totalDuration;
      for (let i = lane.index; i < lane.index + laneSpan && i < this.lanes.length; i++) {
        const laneState = this.lanes[i];
        if (!laneState) continue;
        laneState.lastItemStartTime = startTime;
        laneState.lastItemExitTime = exitTime;
        laneState.lastItemWidthPx = textWidth;
        laneState.lastItemHeightPx = messageHeight;
      }
      animation.addEventListener(
        "finish",
        () => {
          this.removeMessageByElement(element);
        },
        { once: true }
      );
      return {
        element,
        lane: lane.index,
        laneSpan,
        startTime: now,
        duration,
        animation
      };
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
      this.messageQueue.push({
        message,
        nextAttemptAt: 0
      });
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
      this.clearRetryTimer();
      let shortestWaitMs = null;
      while (this.messageQueue.length > 0) {
        let progressed = false;
        const now = Date.now();
        const lookaheadCount = Math.min(LAYOUT.QUEUE_LOOKAHEAD_LIMIT, this.messageQueue.length);
        for (let i = 0; i < lookaheadCount; i++) {
          const queued = this.messageQueue[i];
          if (!queued) continue;
          if (queued.nextAttemptAt > now) {
            const waitMs = queued.nextAttemptAt - now;
            shortestWaitMs = shortestWaitMs === null ? waitMs : Math.min(shortestWaitMs, waitMs);
            continue;
          }
          if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
            this.logPerformanceWarning();
          }
          const result = this.renderMessage(queued.message);
          if (result.status === "rendered") {
            this.messageQueue.splice(i, 1);
            this.processedInLastSecond++;
            progressed = true;
            break;
          }
          if (result.status === "dropped") {
            this.messageQueue.splice(i, 1);
            progressed = true;
            break;
          }
          queued.nextAttemptAt = now + result.waitMs;
          shortestWaitMs = shortestWaitMs === null ? result.waitMs : Math.min(shortestWaitMs, result.waitMs);
        }
        if (!progressed) {
          break;
        }
      }
      if (this.messageQueue.length > 0) {
        this.scheduleRetry(shortestWaitMs ?? LAYOUT.RETRY_DELAY_MAX_MS);
      }
    }
    /**
     * Get effective message speed considering current video playback rate
     */
    getEffectiveSpeedPxPerSec() {
      return Math.max(1, this.settings.speedPxPerSec * this.playbackRate);
    }
    /**
     * Schedule queue processing retry when lanes are temporarily occupied
     */
    scheduleRetry(waitMs) {
      if (this.isPaused) return;
      const delay = Math.max(LAYOUT.RETRY_DELAY_MIN_MS, Math.min(waitMs, LAYOUT.RETRY_DELAY_MAX_MS));
      this.clearRetryTimer();
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        this.processQueue();
      }, delay);
    }
    /**
     * Clear pending queue retry timer
     */
    clearRetryTimer() {
      if (this.retryTimer !== null) {
        window.clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    }
    /**
     * Log performance warning when concurrent message count is high
     * Limited to once per 10 seconds to avoid log spam
     */
    logPerformanceWarning() {
      const now = Date.now();
      if (now - this.lastWarningTime < this.WARNING_INTERVAL_MS) {
        return;
      }
      this.lastWarningTime = now;
      console.warn(
        `[YT Chat Overlay] Performance warning: ${this.activeMessages.size} concurrent messages (recommended max: ${this.settings.maxConcurrentMessages}). Consider reducing maxMessagesPerSecond setting.`
      );
    }
    /**
     * Build message DOM element by message kind
     */
    buildMessageElement(message) {
      const element = document.createElement("div");
      element.className = "yt-chat-overlay-message";
      const isSuperChat = message.kind === "superchat" && Boolean(message.superChat);
      const isMembership = message.kind === "membership";
      if (isSuperChat && message.superChat) {
        this.applySuperChatStyling(element, message.superChat);
        const headerElement = this.createSuperChatHeader(
          message,
          message.superChat,
          this.settings.showAuthor.superChat
        );
        const contentElement = this.createSuperChatContent(message, message.superChat);
        element.appendChild(headerElement);
        if (contentElement) {
          element.appendChild(contentElement);
        }
        return { element, isSuperChat, isMembership };
      }
      if (isMembership) {
        const membershipCard = this.createMembershipCard(message);
        element.appendChild(membershipCard);
        return { element, isSuperChat, isMembership };
      }
      const showAuthor = this.shouldShowAuthor(message);
      if (showAuthor) {
        element.classList.add("yt-chat-overlay-message-with-author");
        const authorElement = this.createAuthorElement(message);
        element.appendChild(authorElement);
      }
      const contentDiv = this.createMessageTextElement(message);
      if (!contentDiv) {
        console.warn("[YT Chat Overlay] Skipping empty message");
        return null;
      }
      element.appendChild(contentDiv);
      return { element, isSuperChat, isMembership };
    }
    /**
     * Apply common visual styles shared by all message kinds
     */
    applyCommonMessageStyles(element, message, isSuperChat, isMembership) {
      element.style.fontSize = `${this.settings.fontSize}px`;
      element.style.opacity = `${this.settings.opacity}`;
      if (!isSuperChat && !isMembership) {
        const authorType = message.authorType || "normal";
        element.style.color = this.settings.colors[authorType];
      }
    }
    /**
     * Append message to DOM in hidden state and measure rendered size
     */
    measureMessageElement(container, element, overlayWidth) {
      element.style.visibility = "hidden";
      element.style.left = `${overlayWidth}px`;
      element.style.top = "0px";
      container.appendChild(element);
      return {
        textWidth: element.offsetWidth,
        messageHeight: element.offsetHeight
      };
    }
    /**
     * Render a single message
     */
    renderMessage(message) {
      const container = this.overlay.getContainer();
      const dimensions = this.overlay.getDimensions();
      if (!container || !dimensions) {
        console.warn("[YT Chat Overlay] Cannot render: container or dimensions missing");
        return { status: "dropped" };
      }
      const builtMessage = this.buildMessageElement(message);
      if (!builtMessage) {
        return { status: "dropped" };
      }
      const { element, isSuperChat, isMembership } = builtMessage;
      this.applyCommonMessageStyles(element, message, isSuperChat, isMembership);
      const { textWidth, messageHeight } = this.measureMessageElement(
        container,
        element,
        dimensions.width
      );
      const placement = this.findLanePlacement(messageHeight);
      if (placement === null) {
        const dimensions2 = this.overlay.getDimensions();
        console.log(
          `[YT Chat Overlay] No available lane for message (height: ${messageHeight}px). Active messages: ${this.activeMessages.size}, Lanes: ${dimensions2?.laneCount || "unknown"}, Queue size: ${this.messageQueue.length}`
        );
        container.removeChild(element);
        return { status: "dropped" };
      }
      if (placement.waitMs > 0) {
        container.removeChild(element);
        return { status: "deferred", waitMs: placement.waitMs };
      }
      const activeMessage = this.setupMessageAnimation(
        element,
        placement,
        textWidth,
        messageHeight,
        dimensions
      );
      this.activeMessages.add(activeMessage);
      console.log("[YT Chat Overlay] Rendering message:", {
        text: message.text.substring(0, 20),
        author: message.author,
        authorType: message.authorType || "normal",
        kind: message.kind,
        isSuperChat,
        superChatTier: message.superChat?.tier,
        superChatAmount: message.superChat?.amount,
        color: isSuperChat ? "tier-based" : this.settings.colors[message.authorType || "normal"],
        lane: placement.lane.index,
        laneSpan: placement.laneSpan,
        width: textWidth,
        height: messageHeight,
        dimensions
      });
      return { status: "rendered" };
    }
    /**
     * Calculate required lane count for a message
     */
    calculateRequiredLanes(messageHeight, laneHeight) {
      const paddingPx = Math.max(
        LAYOUT.LANE_HEIGHT_PADDING_MIN,
        this.settings.fontSize * LAYOUT.LANE_HEIGHT_PADDING_SCALE
      );
      return Math.max(1, Math.ceil((messageHeight + paddingPx) / laneHeight));
    }
    /**
     * Calculate lane ready time for a new message width
     */
    calculateLaneReadyTime(lane, now) {
      if (lane.lastItemStartTime <= 0) {
        return now;
      }
      const baseSafeDistance = this.settings.fontSize * LAYOUT.SAFE_DISTANCE_SCALE;
      const minSafeDistance = Math.max(baseSafeDistance, LAYOUT.SAFE_DISTANCE_MIN);
      const requiredGapPx = lane.lastItemWidthPx + minSafeDistance;
      const safeTimeGap = requiredGapPx / this.getEffectiveSpeedPxPerSec() * 1e3;
      const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;
      const verticalClearTime = Math.min(
        LAYOUT.VERTICAL_CLEAR_TIME_MAX,
        Math.max(LAYOUT.VERTICAL_CLEAR_TIME_MIN, lane.lastItemHeightPx * 4)
      );
      const verticalReadyTime = lane.lastItemStartTime + verticalClearTime;
      return Math.max(now, horizontalReadyTime, verticalReadyTime);
    }
    /**
     * Find the best lane placement (position + timing)
     */
    findLanePlacement(messageHeight) {
      const now = Date.now();
      const dimensions = this.overlay.getDimensions();
      if (!dimensions) return null;
      const requiredLanes = this.calculateRequiredLanes(messageHeight, dimensions.laneHeight);
      if (requiredLanes > this.lanes.length) {
        return null;
      }
      let bestLane = null;
      let bestReadyTime = Number.POSITIVE_INFINITY;
      for (let i = 0; i <= this.lanes.length - requiredLanes; i++) {
        let blockReadyTime = now;
        for (let offset = 0; offset < requiredLanes; offset++) {
          const lane = this.lanes[i + offset];
          if (!lane) {
            blockReadyTime = Number.POSITIVE_INFINITY;
            break;
          }
          const laneReadyTime = this.calculateLaneReadyTime(lane, now);
          blockReadyTime = Math.max(blockReadyTime, laneReadyTime);
        }
        if (blockReadyTime < bestReadyTime || blockReadyTime === bestReadyTime && bestLane && i < bestLane.index) {
          bestReadyTime = blockReadyTime;
          bestLane = this.lanes[i] || null;
        }
      }
      if (!bestLane || !Number.isFinite(bestReadyTime)) {
        return null;
      }
      return {
        lane: bestLane,
        laneSpan: requiredLanes,
        waitMs: Math.max(0, Math.ceil(bestReadyTime - now))
      };
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
      try {
        if (active.animation.playState !== "finished") {
          active.animation.cancel();
        }
      } catch {
      }
      if (active.element.parentNode) {
        active.element.parentNode.removeChild(active.element);
      }
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
      this.pausedAt = Date.now();
      this.clearRetryTimer();
      this.forEachAnimation((animation) => animation.pause());
      console.log(`[Renderer] Paused ${this.activeMessages.size} animations`);
    }
    /**
     * Resume all active animations and process queued messages
     */
    resume() {
      if (!this.isPaused) return;
      const now = Date.now();
      if (this.pausedAt !== null) {
        const pausedDuration = Math.max(0, now - this.pausedAt);
        if (pausedDuration > 0) {
          for (const lane of this.lanes) {
            if (lane.lastItemStartTime > 0) {
              lane.lastItemStartTime += pausedDuration;
            }
            if (lane.lastItemExitTime > 0) {
              lane.lastItemExitTime += pausedDuration;
            }
          }
          if (this.lastProcessTime > 0) {
            this.lastProcessTime += pausedDuration;
          }
        }
      }
      this.pausedAt = null;
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
      this.playbackRate = rate;
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
      this.clearRetryTimer();
      this.pausedAt = null;
      this.playbackRate = 1;
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
          top: ${spacing.sm}px;
          right: ${spacing.sm}px;
          width: ${spacing.xxxl}px;
          height: ${spacing.xxxl}px;
          border-radius: ${borderRadius.sm};
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(0, 0, 0, 0.6);
          color: ${colors.ui.text};
          font-size: ${typography.fontSize.base};
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
          z-index: ${zIndex.modal};
        }
        .yt-chat-overlay-settings-modal {
          width: 380px;
          max-height: 82vh;
          overflow: auto;
          background: ${colors.ui.background};
          color: ${colors.ui.text};
          border-radius: ${borderRadius.md};
          padding: ${spacing.lg}px;
          display: flex;
          flex-direction: column;
          gap: ${spacing.lg}px;
          font-family: system-ui, -apple-system, sans-serif;
          box-shadow: ${shadows.box.lg};
        }
        .yt-chat-overlay-settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: ${typography.fontWeight.bold};
          font-size: ${typography.fontSize.base};
        }
        .yt-chat-overlay-settings-close {
          border: none;
          background: transparent;
          color: ${colors.ui.text};
          font-size: ${typography.fontSize.lg};
          cursor: pointer;
        }
        .yt-chat-overlay-settings-section {
          display: flex;
          flex-direction: column;
          gap: ${spacing.md}px;
        }
        .yt-chat-overlay-settings-section-title {
          font-size: ${typography.fontSize.xs};
          color: ${colors.ui.textMuted};
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .yt-chat-overlay-settings-field {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: ${spacing.md}px;
          font-size: ${typography.fontSize.sm};
        }
        .yt-chat-overlay-settings-field input[type="number"] {
          width: 110px;
          padding: ${spacing.xs}px ${spacing.sm}px;
          border-radius: ${borderRadius.sm};
          border: 1px solid ${colors.ui.border};
          background: ${colors.ui.backgroundLight};
          color: ${colors.ui.text};
        }
        .yt-chat-overlay-settings-field input[type="color"] {
          width: 48px;
          height: 28px;
          border: none;
          background: transparent;
          padding: 0;
        }
        .yt-chat-overlay-settings-field input[type="checkbox"] {
          width: 18px;
          height: 18px;
          cursor: pointer;
        }
        .yt-chat-overlay-settings-field select {
          padding: ${spacing.xs}px ${spacing.sm}px;
          border-radius: ${borderRadius.sm};
          border: 1px solid ${colors.ui.border};
          background: ${colors.ui.backgroundLight};
          color: ${colors.ui.text};
          cursor: pointer;
        }
        .yt-chat-overlay-author-grid {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: ${spacing.sm}px ${spacing.md}px;
          align-items: center;
          padding: ${spacing.sm}px 0;
        }
        .yt-chat-overlay-author-grid-label {
          font-size: ${typography.fontSize.sm};
          min-width: 80px;
        }
        .yt-chat-overlay-author-grid-color {
          justify-self: end;
        }
        .yt-chat-overlay-author-grid-checkbox {
          justify-self: end;
        }
        .yt-chat-overlay-settings-actions {
          display: flex;
          justify-content: flex-end;
          gap: ${spacing.sm}px;
          padding-top: ${spacing.xs}px;
        }
        .yt-chat-overlay-settings-actions button {
          border: none;
          border-radius: ${borderRadius.sm};
          padding: ${spacing.sm}px ${spacing.md}px;
          cursor: pointer;
          font-weight: ${typography.fontWeight.semibold};
        }
        .yt-chat-overlay-settings-actions button[data-action="reset"] {
          background: ${colors.ui.danger};
          color: ${colors.ui.text};
        }
        .yt-chat-overlay-settings-actions button[data-action="apply"] {
          background: ${colors.ui.primary};
          color: ${colors.ui.text};
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
          <input type="number" name="speedPxPerSec" min="100" max="400" step="10" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Font size (px)</span>
          <input type="number" name="fontSize" min="18" max="40" step="2" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="opacity" min="0.5" max="1" step="0.05" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Super Chat color opacity (%)</span>
          <input type="number" name="superChatOpacity" min="40" max="100" step="5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe top (%)</span>
          <input type="number" name="safeTop" min="0" max="25" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe bottom (%)</span>
          <input type="number" name="safeBottom" min="0" max="25" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Warning threshold</span>
          <input
            type="number"
            name="maxConcurrentMessages"
            min="30"
            max="100"
            step="10"
            title="Performance warning threshold (not enforced)"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Max messages/s</span>
          <input
            type="number"
            name="maxMessagesPerSecond"
            min="5"
            max="20"
            step="1"
            title="Rate limit for new messages (enforced)"
          />
        </label>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Author Types (Color & Display)</div>
        <div class="yt-chat-overlay-author-grid">
          <span class="yt-chat-overlay-author-grid-label">Normal</span>
          <input type="color" name="color-normal" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-normal" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Member</span>
          <input type="color" name="color-member" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-member" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Moderator</span>
          <input type="color" name="color-moderator" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-moderator" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Owner</span>
          <input type="color" name="color-owner" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-owner" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Verified</span>
          <input type="color" name="color-verified" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-verified" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Super Chat</span>
          <span></span>
          <input type="checkbox" name="showAuthor-superChat" class="yt-chat-overlay-author-grid-checkbox" />
        </div>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Outline</div>
        <label class="yt-chat-overlay-settings-field">
          <span>Enabled</span>
          <input type="checkbox" name="outline-enabled" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Width (px)</span>
          <input type="number" name="outline-widthPx" min="0" max="5" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Blur (px)</span>
          <input type="number" name="outline-blurPx" min="0" max="8" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="outline-opacity" min="0" max="1" step="0.1" />
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
      this.setValue("superChatOpacity", (settings.superChatOpacity * 100).toFixed(0));
      this.setValue("safeTop", (settings.safeTop * 100).toFixed(1));
      this.setValue("safeBottom", (settings.safeBottom * 100).toFixed(1));
      this.setValue("maxConcurrentMessages", settings.maxConcurrentMessages);
      this.setValue("maxMessagesPerSecond", settings.maxMessagesPerSecond);
      this.setValue("color-normal", settings.colors.normal);
      this.setValue("color-member", settings.colors.member);
      this.setValue("color-moderator", settings.colors.moderator);
      this.setValue("color-owner", settings.colors.owner);
      this.setValue("color-verified", settings.colors.verified);
      this.setCheckbox("showAuthor-normal", settings.showAuthor.normal);
      this.setCheckbox("showAuthor-member", settings.showAuthor.member);
      this.setCheckbox("showAuthor-moderator", settings.showAuthor.moderator);
      this.setCheckbox("showAuthor-owner", settings.showAuthor.owner);
      this.setCheckbox("showAuthor-verified", settings.showAuthor.verified);
      this.setCheckbox("showAuthor-superChat", settings.showAuthor.superChat);
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
        speedPxPerSec: clamp(readNumber("speedPxPerSec", current.speedPxPerSec), 100, 400),
        fontSize: clamp(readNumber("fontSize", current.fontSize), 18, 40),
        opacity: clamp(readNumber("opacity", current.opacity), 0.5, 1),
        superChatOpacity: clamp(readNumber("superChatOpacity", current.superChatOpacity * 100), 40, 100) / 100,
        safeTop: clamp(readNumber("safeTop", current.safeTop * 100), 0, 25) / 100,
        safeBottom: clamp(readNumber("safeBottom", current.safeBottom * 100), 0, 25) / 100,
        maxConcurrentMessages: Math.round(
          clamp(readNumber("maxConcurrentMessages", current.maxConcurrentMessages), 30, 100)
        ),
        maxMessagesPerSecond: Math.round(
          clamp(readNumber("maxMessagesPerSecond", current.maxMessagesPerSecond), 5, 20)
        ),
        showAuthor: {
          normal: this.getCheckbox("showAuthor-normal", current.showAuthor.normal),
          member: this.getCheckbox("showAuthor-member", current.showAuthor.member),
          moderator: this.getCheckbox("showAuthor-moderator", current.showAuthor.moderator),
          owner: this.getCheckbox("showAuthor-owner", current.showAuthor.owner),
          verified: this.getCheckbox("showAuthor-verified", current.showAuthor.verified),
          superChat: this.getCheckbox("showAuthor-superChat", current.showAuthor.superChat)
        },
        colors: {
          normal: this.getColor("color-normal", current.colors.normal),
          member: this.getColor("color-member", current.colors.member),
          moderator: this.getColor("color-moderator", current.colors.moderator),
          owner: this.getColor("color-owner", current.colors.owner),
          verified: this.getColor("color-verified", current.colors.verified)
        },
        outline: {
          enabled: this.getCheckbox("outline-enabled", current.outline.enabled),
          widthPx: clamp(readNumber("outline-widthPx", current.outline.widthPx), 0, 5),
          blurPx: clamp(readNumber("outline-blurPx", current.outline.blurPx), 0, 8),
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
      this.callbacks.onRateChange?.(video.playbackRate || 1);
      if (video.paused) {
        this.callbacks.onPause?.();
      } else {
        this.callbacks.onPlay?.();
      }
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
