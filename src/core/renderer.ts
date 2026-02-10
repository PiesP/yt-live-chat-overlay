/**
 * Renderer
 *
 * Renders chat messages with Nico-nico style flowing animation.
 * Manages lanes and collision detection.
 */

import type {
  ChatMessage,
  ContentSegment,
  EmojiInfo,
  LaneState,
  OutlineSettings,
  OverlaySettings,
} from '@app-types';
import type { Overlay } from './overlay';

interface ActiveMessage {
  element: HTMLDivElement;
  lane: number;
  startTime: number;
  duration: number;
  timeoutId: number;
  animation: Animation;
}

export class Renderer {
  private overlay: Overlay;
  private settings: OverlaySettings;
  private lanes: LaneState[] = [];
  private activeMessages: Set<ActiveMessage> = new Set();
  private messageQueue: ChatMessage[] = [];
  private lastProcessTime = 0;
  private processedInLastSecond = 0;
  private isPaused = false;
  private styleElement: HTMLStyleElement | null = null;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.initLanes();
    this.injectStyles();
  }

  /**
   * Initialize lanes
   */
  private initLanes(): void {
    const dimensions = this.overlay.getDimensions();
    if (!dimensions) return;

    this.lanes = Array.from({ length: dimensions.laneCount }, (_, i) => ({
      index: i,
      lastItemExitTime: 0,
      lastItemStartTime: 0,
      lastItemWidthPx: 0,
      lastItemHeightPx: 0,
    }));
  }

  /**
   * Inject CSS animations
   */
  private injectStyles(): void {
    if (!this.styleElement) {
      this.styleElement = document.createElement('style');
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

      /* Message with author display */
      .yt-chat-overlay-message-with-author {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      /* Author info line */
      .yt-chat-overlay-author-info {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.85em;
        opacity: 0.95;
      }

      /* Author photo */
      .yt-chat-overlay-author-photo {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        flex-shrink: 0;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
      }

      /* Author name */
      .yt-chat-overlay-author-name {
        font-weight: 600;
      }

      /* Message content line */
      .yt-chat-overlay-message-content {
        display: block;
      }

      /* Super Chat styling */
      .yt-chat-overlay-message-superchat {
        padding: 8px 16px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.4);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
        border: 3px solid rgba(255, 255, 255, 0.9);
      }

      /* Super Chat amount badge */
      .yt-chat-overlay-superchat-amount {
        display: inline-block;
        padding: 4px 12px;
        margin-right: 12px;
        border-radius: 12px;
        font-weight: 900;
        font-size: 0.9em;
        vertical-align: middle;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
      }

      /* Super Chat sticker */
      .yt-chat-overlay-superchat-sticker {
        display: inline-block;
        vertical-align: middle;
        margin-right: 8px;
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5));
      }

      /* Super Chat tier colors */
      .yt-chat-overlay-superchat-blue {
        border-color: rgb(30, 136, 229);
        background: rgba(30, 136, 229, 0.4);
      }
      .yt-chat-overlay-superchat-cyan {
        border-color: rgb(0, 191, 255);
        background: rgba(0, 191, 255, 0.4);
      }
      .yt-chat-overlay-superchat-green {
        border-color: rgb(29, 233, 182);
        background: rgba(29, 233, 182, 0.4);
      }
      .yt-chat-overlay-superchat-yellow {
        border-color: rgb(255, 202, 40);
        background: rgba(255, 202, 40, 0.4);
      }
      .yt-chat-overlay-superchat-orange {
        border-color: rgb(245, 124, 0);
        background: rgba(245, 124, 0, 0.4);
      }
      .yt-chat-overlay-superchat-magenta {
        border-color: rgb(233, 30, 99);
        background: rgba(233, 30, 99, 0.4);
      }
      .yt-chat-overlay-superchat-red {
        border-color: rgb(230, 33, 23);
        background: rgba(230, 33, 23, 0.4);
      }

      /* Super Chat amount badge tier colors */
      .yt-chat-overlay-superchat-amount-blue { background-color: rgb(30, 136, 229); }
      .yt-chat-overlay-superchat-amount-cyan { background-color: rgb(0, 191, 255); }
      .yt-chat-overlay-superchat-amount-green { background-color: rgb(29, 233, 182); }
      .yt-chat-overlay-superchat-amount-yellow { background-color: rgb(255, 202, 40); color: #000; }
      .yt-chat-overlay-superchat-amount-orange { background-color: rgb(245, 124, 0); }
      .yt-chat-overlay-superchat-amount-magenta { background-color: rgb(233, 30, 99); }
      .yt-chat-overlay-superchat-amount-red { background-color: rgb(230, 33, 23); }

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

  private buildTextShadow(outline: OutlineSettings): string {
    if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
      return 'none';
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
      `0px 0px ${glowStrongBlur}px ${glowStrongColor}`,
    ].join(', ');
  }

  private buildTextStroke(outline: OutlineSettings): string {
    if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
      return '0 transparent';
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
  private isValidImageUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
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
   * Parse RGB/RGBA color string to components
   * Handles formats: "rgb(r, g, b)" or "rgba(r, g, b, a)"
   */
  private parseRgbaColor(colorString: string): {
    r: number;
    g: number;
    b: number;
    a: number;
  } | null {
    const rgbaMatch = colorString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!rgbaMatch) return null;

    return {
      r: parseInt(rgbaMatch[1] || '0', 10),
      g: parseInt(rgbaMatch[2] || '0', 10),
      b: parseInt(rgbaMatch[3] || '0', 10),
      a: rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1.0,
    };
  }

  /**
   * Create semi-transparent background from base color
   * Returns a solid semi-transparent background
   */
  private createSemiTransparentBackground(colorString: string): string {
    const parsed = this.parseRgbaColor(colorString);
    if (!parsed) {
      // Fallback to default semi-transparent black
      return 'rgba(0, 0, 0, 0.4)';
    }

    // Create semi-transparent background (40% opacity)
    return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, 0.4)`;
  }

  /**
   * Determine if color is light or dark (for text contrast)
   * Uses relative luminance formula
   */
  private isLightColor(colorString: string): boolean {
    const parsed = this.parseRgbaColor(colorString);
    if (!parsed) return false;

    // Calculate relative luminance
    const luminance = (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
    return luminance > 0.5;
  }

  /**
   * Create emoji img element with proper styling
   * SECURITY: Validates URL and creates element programmatically
   */
  private createEmojiElement(emoji: EmojiInfo): HTMLImageElement | null {
    // Re-validate URL (defense in depth)
    if (!this.isValidImageUrl(emoji.url)) {
      console.warn('[YT Chat Overlay] Invalid emoji URL:', emoji.url);
      return null;
    }

    const img = document.createElement('img');

    // Set source (validated)
    img.src = emoji.url;

    // Set alt text (textContent, safe)
    img.alt = emoji.alt || '';

    // Apply styling
    img.className = 'yt-chat-overlay-emoji';
    img.style.display = 'inline-block';
    img.style.verticalAlign = 'text-bottom';

    // Size emoji relative to font size
    // Standard emoji: 1.2em (slightly larger than text)
    // Member emoji: 1.4em (more prominent)
    const sizeFactor = emoji.type === 'member' ? 1.4 : 1.2;
    const emojiSize = this.settings.fontSize * sizeFactor;

    img.style.height = `${emojiSize}px`;
    img.style.width = 'auto'; // Maintain aspect ratio

    // Add special styling for member emojis
    if (emoji.type === 'member') {
      img.classList.add('yt-chat-overlay-emoji-member');
    }

    // Error handling: hide on load failure
    img.addEventListener(
      'error',
      () => {
        img.style.display = 'none';
        console.warn('[YT Chat Overlay] Failed to load emoji:', emoji.url);
      },
      { once: true }
    );

    // Prevent dragging
    img.draggable = false;

    return img;
  }

  /**
   * Create Super Chat sticker image element
   * SECURITY: Validates URL and creates element programmatically
   */
  private createSuperChatSticker(stickerUrl: string): HTMLImageElement | null {
    // Validate URL (defense in depth)
    if (!this.isValidImageUrl(stickerUrl)) {
      console.warn('[YT Chat Overlay] Invalid Super Chat sticker URL:', stickerUrl);
      return null;
    }

    const img = document.createElement('img');
    img.src = stickerUrl;
    img.alt = 'Super Chat Sticker';
    img.className = 'yt-chat-overlay-superchat-sticker';

    // Size sticker relative to font size (larger than emoji)
    const stickerSize = this.settings.fontSize * 2.0;
    img.style.height = `${stickerSize}px`;
    img.style.width = 'auto';

    // Error handling: hide on load failure
    img.addEventListener(
      'error',
      () => {
        img.style.display = 'none';
        console.warn('[YT Chat Overlay] Failed to load Super Chat sticker:', stickerUrl);
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
  private renderMixedContent(container: HTMLDivElement, segments: ContentSegment[]): void {
    for (const segment of segments) {
      if (segment.type === 'text') {
        // Create text node (safe)
        const textNode = document.createTextNode(segment.content);
        container.appendChild(textNode);
      } else if (segment.type === 'emoji') {
        // Create img element programmatically (safe)
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
  private shouldShowAuthor(message: ChatMessage): boolean {
    const settings = this.settings.showAuthor;

    // Check if Super Chat
    if (message.kind === 'superchat') {
      return settings.superChat;
    }

    // Check author type
    const authorType = message.authorType || 'normal';
    return settings[authorType] || false;
  }

  /**
   * Create author info element (photo + name)
   * SECURITY: Validates photo URL and creates elements programmatically
   */
  private createAuthorElement(message: ChatMessage): HTMLDivElement {
    const authorInfoDiv = document.createElement('div');
    authorInfoDiv.className = 'yt-chat-overlay-author-info';

    // Add author photo if available
    if (message.authorPhotoUrl && this.isValidImageUrl(message.authorPhotoUrl)) {
      const photoImg = document.createElement('img');
      photoImg.src = message.authorPhotoUrl;
      photoImg.alt = message.author || 'Author';
      photoImg.className = 'yt-chat-overlay-author-photo';
      photoImg.draggable = false;

      // Error handling: hide on load failure
      photoImg.addEventListener(
        'error',
        () => {
          photoImg.style.display = 'none';
        },
        { once: true }
      );

      authorInfoDiv.appendChild(photoImg);
    }

    // Add author name
    if (message.author) {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'yt-chat-overlay-author-name';
      nameSpan.textContent = message.author;

      // Apply color based on author type
      const authorType = message.authorType || 'normal';
      nameSpan.style.color = this.settings.colors[authorType];

      authorInfoDiv.appendChild(nameSpan);
    }

    return authorInfoDiv;
  }

  /**
   * Add message to render queue
   */
  addMessage(message: ChatMessage): void {
    // Rate limiting check
    const now = Date.now();
    if (now - this.lastProcessTime > 1000) {
      this.processedInLastSecond = 0;
      this.lastProcessTime = now;
    }

    if (this.processedInLastSecond >= this.settings.maxMessagesPerSecond) {
      // Drop message
      return;
    }

    this.messageQueue.push(message);

    // Only process queue if not paused
    if (!this.isPaused) {
      this.processQueue();
    }
    // If paused, message stays in queue until resume()
  }

  /**
   * Process message queue
   */
  private processQueue(): void {
    // Don't process while paused
    if (this.isPaused) {
      return;
    }

    while (this.messageQueue.length > 0) {
      // Check concurrent message limit
      if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
        // Remove oldest message
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
  private renderMessage(message: ChatMessage): void {
    const container = this.overlay.getContainer();
    const dimensions = this.overlay.getDimensions();
    if (!container || !dimensions) {
      console.warn('[YT Chat Overlay] Cannot render: container or dimensions missing');
      return;
    }

    // Create message element
    const element = document.createElement('div');
    element.className = 'yt-chat-overlay-message';

    // Check if we should show author info
    const showAuthor = this.shouldShowAuthor(message);
    if (showAuthor) {
      element.classList.add('yt-chat-overlay-message-with-author');
    }

    // Apply Super Chat styling if applicable
    const isSuperChat = message.kind === 'superchat' && message.superChat;
    if (isSuperChat && message.superChat) {
      element.classList.add('yt-chat-overlay-message-superchat');

      // Use actual YouTube colors if available, otherwise fallback to tier-based CSS
      if (message.superChat.backgroundColor) {
        // Apply dynamic styling based on actual YouTube colors
        const bgColor = message.superChat.backgroundColor;
        const semiTransparentBg = this.createSemiTransparentBackground(bgColor);
        const borderColor = bgColor; // Use original color for border (solid)

        element.style.background = semiTransparentBg;
        element.style.borderColor = borderColor;

        console.log('[YT Chat Overlay] Using actual YouTube color:', {
          original: bgColor,
          background: semiTransparentBg,
          borderColor,
        });
      } else {
        // Fallback to tier-based CSS classes
        element.classList.add(`yt-chat-overlay-superchat-${message.superChat.tier}`);
        console.log('[YT Chat Overlay] Using fallback tier color:', message.superChat.tier);
      }

      // Add sticker if available (high-tier Super Chats)
      if (message.superChat.stickerUrl) {
        const stickerImg = this.createSuperChatSticker(message.superChat.stickerUrl);
        if (stickerImg) {
          element.appendChild(stickerImg);
        }
      }

      // Add amount badge with dynamic or tier-based color
      const amountBadge = document.createElement('span');
      amountBadge.className = 'yt-chat-overlay-superchat-amount';

      // Use header background color for badge, or fallback to main background color
      const badgeColor =
        message.superChat.headerBackgroundColor || message.superChat.backgroundColor;

      if (badgeColor) {
        // Apply actual YouTube color to badge
        amountBadge.style.backgroundColor = badgeColor;

        // Adjust text color based on background brightness
        const isLight = this.isLightColor(badgeColor);
        amountBadge.style.color = isLight ? '#000' : '#fff';

        console.log('[YT Chat Overlay] Badge color:', {
          backgroundColor: badgeColor,
          textColor: isLight ? '#000' : '#fff',
        });
      } else {
        // Fallback to tier-based CSS class for badge
        amountBadge.classList.add(`yt-chat-overlay-superchat-amount-${message.superChat.tier}`);
      }

      amountBadge.textContent = message.superChat.amount;
      element.appendChild(amountBadge);
    }

    // Add author info if needed
    if (showAuthor) {
      const authorElement = this.createAuthorElement(message);
      element.appendChild(authorElement);
    }

    // Create content container
    const contentDiv = document.createElement('div');
    contentDiv.className = 'yt-chat-overlay-message-content';

    // Render content (text + emojis)
    if (message.content && message.content.length > 0) {
      this.renderMixedContent(contentDiv, message.content);
    } else {
      contentDiv.textContent = message.text; // SECURITY: textContent only, no innerHTML
    }

    element.appendChild(contentDiv);

    // Font size is same for all messages
    const fontSize = this.settings.fontSize;
    element.style.fontSize = `${fontSize}px`;
    element.style.opacity = `${this.settings.opacity}`;

    // Apply color based on author type (unless it's a Super Chat with custom styling)
    if (!isSuperChat) {
      const authorType = message.authorType || 'normal';
      element.style.color = this.settings.colors[authorType];
    }

    // Add to container temporarily to measure dimensions
    element.style.visibility = 'hidden';
    element.style.left = `${dimensions.width}px`;
    element.style.top = '0px';
    container.appendChild(element);

    // Measure actual message dimensions
    const textWidth = element.offsetWidth;
    const messageHeight = element.offsetHeight;

    // Find available lane based on message height
    const lane = this.findAvailableLane(messageHeight);
    if (lane === null) {
      // No available lane, drop message
      console.log('[YT Chat Overlay] No available lane, dropping message');
      container.removeChild(element);
      return;
    }

    // Position element at the assigned lane
    const laneY = dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
    element.style.top = `${laneY}px`;
    element.style.visibility = 'visible';
    // Calculate animation duration and padding
    const exitPadding = Math.max(fontSize * 3, 100); // Increased for smoother exit
    const distance = dimensions.width + textWidth + exitPadding;

    // Optimized duration: 5-12 seconds range for better pacing
    const duration = Math.max(
      5000,
      Math.min(12000, (distance / this.settings.speedPxPerSec) * 1000)
    );
    // Staggered lane delay for visual variety
    const laneDelay = (lane.index % 4) * 100;
    const totalDuration = duration + laneDelay;

    // Use Web Animations API for dynamic animation
    // Start from current position (right edge) and move to left edge (off-screen)
    const animation = element.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
      {
        duration,
        delay: laneDelay,
        easing: 'linear',
        fill: 'forwards',
      }
    );

    console.log('[YT Chat Overlay] Rendering message:', {
      text: message.text.substring(0, 20),
      author: message.author,
      authorType: message.authorType || 'normal',
      kind: message.kind,
      isSuperChat,
      superChatTier: message.superChat?.tier,
      superChatAmount: message.superChat?.amount,
      color: isSuperChat ? 'tier-based' : this.settings.colors[message.authorType || 'normal'],
      lane: lane.index,
      width: textWidth,
      height: messageHeight,
      distance,
      duration,
      delay: laneDelay,
      totalDuration,
      dimensions,
    });

    // Update lane state with message dimensions
    const now = Date.now();
    lane.lastItemStartTime = now + laneDelay;
    lane.lastItemExitTime = now + totalDuration;
    lane.lastItemWidthPx = textWidth;
    lane.lastItemHeightPx = messageHeight;

    // Setup cleanup timeout (duration + buffer)
    const timeoutId = window.setTimeout(() => {
      this.removeMessageByElement(element);
    }, totalDuration + 2000);

    // Track active message
    const activeMessage: ActiveMessage = {
      element,
      lane: lane.index,
      startTime: now,
      duration,
      timeoutId,
      animation,
    };
    this.activeMessages.add(activeMessage);

    // Auto-remove on animation end
    animation.addEventListener(
      'finish',
      () => {
        this.removeMessageByElement(element);
      },
      { once: true }
    );
  }

  /**
   * Find available lane (collision avoidance)
   * Considers both horizontal and vertical collision
   */
  private findAvailableLane(messageHeight: number): LaneState | null {
    const now = Date.now();
    const dimensions = this.overlay.getDimensions();
    if (!dimensions) return null;

    // Calculate how many lanes this message needs based on its height
    const requiredLanes = Math.ceil(messageHeight / dimensions.laneHeight);

    for (let i = 0; i <= this.lanes.length - requiredLanes; i++) {
      const primaryLane = this.lanes[i];

      // Check if primary lane is available (horizontal collision check)
      if (primaryLane && primaryLane.lastItemStartTime === 0) {
        // Check vertical space availability for adjacent lanes if needed
        if (requiredLanes > 1 && !this.checkVerticalSpace(i, requiredLanes)) {
          continue;
        }
        return primaryLane;
      }

      // Calculate safe time gap for horizontal collision avoidance
      if (primaryLane) {
        // Dynamic safe distance based on message type and font size
        const baseSafeDistance = this.settings.fontSize * 2;
        const minSafeDistance = Math.max(baseSafeDistance, 100);
        const requiredGapPx =
          Math.max(primaryLane.lastItemWidthPx, minSafeDistance) + minSafeDistance;
        const safeTimeGap = (requiredGapPx / this.settings.speedPxPerSec) * 1000;

        // Check if enough time has passed since last message started
        const timeSinceLastStart = now - primaryLane.lastItemStartTime;

        if (timeSinceLastStart >= safeTimeGap) {
          // Check vertical space availability for adjacent lanes if needed
          if (requiredLanes > 1 && !this.checkVerticalSpace(i, requiredLanes)) {
            continue;
          }
          return primaryLane;
        }
      }
    }

    return null; // No available lane
  }

  /**
   * Check if vertical space is available for multi-lane messages
   */
  private checkVerticalSpace(startLaneIndex: number, requiredLanes: number): boolean {
    const now = Date.now();

    for (let i = startLaneIndex; i < startLaneIndex + requiredLanes && i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      if (!lane) return false;

      // Skip the primary lane (already checked)
      if (i === startLaneIndex) continue;

      // Check if adjacent lane is clear or will be clear soon
      if (lane.lastItemStartTime > 0) {
        const timeSinceLastStart = now - lane.lastItemStartTime;
        // Shorter clear time for better space utilization
        const minClearTime = 800; // 0.8 seconds

        if (timeSinceLastStart < minClearTime) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Remove message by element
   */
  private removeMessageByElement(element: HTMLDivElement): void {
    const active = Array.from(this.activeMessages).find((m) => m.element === element);
    if (active) {
      this.removeMessage(active);
    }
  }

  /**
   * Remove active message
   */
  private removeMessage(active: ActiveMessage): void {
    if (active.element.parentNode) {
      active.element.parentNode.removeChild(active.element);
    }
    clearTimeout(active.timeoutId);
    this.activeMessages.delete(active);
  }

  /**
   * Update settings
   */
  updateSettings(settings: OverlaySettings): void {
    this.settings = settings;
    this.initLanes();
    this.injectStyles();
  }

  /**
   * Pause all active animations
   */
  pause(): void {
    if (this.isPaused) return;

    console.log('[Renderer] Pausing all animations');
    this.isPaused = true;
    this.forEachAnimation((animation) => animation.pause());
    console.log(`[Renderer] Paused ${this.activeMessages.size} animations`);
  }

  /**
   * Resume all active animations and process queued messages
   */
  resume(): void {
    if (!this.isPaused) return;

    console.log('[Renderer] Resuming all animations');
    this.isPaused = false;
    this.forEachAnimation((animation) => animation.play());
    console.log(`[Renderer] Resumed ${this.activeMessages.size} animations`);

    // Process any queued messages
    this.processQueue();
  }

  /**
   * Check if renderer is paused
   */
  isPausedState(): boolean {
    return this.isPaused;
  }

  /**
   * Set playback rate for all active animations
   * Synchronizes animation speed with video playback rate
   */
  setPlaybackRate(rate: number): void {
    if (rate <= 0) {
      console.warn('[Renderer] Invalid playback rate:', rate);
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
  private forEachAnimation(operation: (animation: Animation) => void): void {
    for (const active of this.activeMessages) {
      try {
        operation(active.animation);
      } catch (error) {
        console.warn('[Renderer] Animation operation failed:', error);
      }
    }
  }

  /**
   * Clear all messages
   */
  clear(): void {
    for (const active of this.activeMessages) {
      this.removeMessage(active);
    }
    this.activeMessages.clear();
    this.messageQueue = [];
  }

  /**
   * Destroy renderer
   */
  destroy(): void {
    this.isPaused = false;
    this.clear();
    if (this.styleElement?.parentNode) {
      this.styleElement.parentNode.removeChild(this.styleElement);
    }
    this.styleElement = null;
  }
}
