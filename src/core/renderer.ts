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
  OverlayDimensions,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import { borderRadius, colors, rgba, shadows, spacing, typography } from './design-tokens.js';
import type { Overlay } from './overlay';

interface ActiveMessage {
  element: HTMLDivElement;
  lane: number;
  laneSpan: number;
  startTime: number;
  duration: number;
  animation: Animation;
}

interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
}

type RenderResult =
  | { status: 'rendered' }
  | { status: 'dropped' }
  | { status: 'deferred'; waitMs: number };

interface LanePlacement {
  lane: LaneState;
  laneSpan: number;
  waitMs: number;
}

/**
 * Layout and styling constants
 */
const LAYOUT = {
  // Author display
  AUTHOR_PHOTO_SIZE: 24, // px
  AUTHOR_FONT_SCALE: 0.85, // relative to base fontSize

  // Emoji sizing
  EMOJI_SIZE_STANDARD: 1.2, // relative to base fontSize
  EMOJI_SIZE_MEMBER: 1.4, // relative to base fontSize

  // Super Chat
  SUPERCHAT_STICKER_SIZE: 2.0, // relative to base fontSize

  // Animation
  EXIT_PADDING_MIN: 100, // px
  EXIT_PADDING_SCALE: 3, // relative to fontSize
  DURATION_MIN: 5000, // ms
  DURATION_MAX: 12000, // ms
  LANE_DELAY_CYCLE: 4, // number of lanes before repeating delay pattern
  LANE_DELAY_MS: 100, // ms per lane cycle

  // Collision detection
  SAFE_DISTANCE_SCALE: 2, // relative to fontSize
  SAFE_DISTANCE_MIN: 100, // px
  VERTICAL_CLEAR_TIME: 800, // ms
  LANE_HEIGHT_PADDING_SCALE: 0.15, // relative to fontSize
  LANE_HEIGHT_PADDING_MIN: 2, // px
  RETRY_DELAY_MIN_MS: 16, // ms
  RETRY_DELAY_MAX_MS: 1000, // ms
  QUEUE_LOOKAHEAD_LIMIT: 8, // queue scan window for scheduling
} as const;

export class Renderer {
  private overlay: Overlay;
  private settings: OverlaySettings;
  private lanes: LaneState[] = [];
  private activeMessages: Set<ActiveMessage> = new Set();
  private messageQueue: QueuedMessage[] = [];
  private lastProcessTime = 0;
  private processedInLastSecond = 0;
  private isPaused = false;
  private pausedAt: number | null = null;
  private playbackRate = 1;
  private lastWarningTime = 0;
  private readonly WARNING_INTERVAL_MS = 10000;
  private styleElement: HTMLStyleElement | null = null;
  private retryTimer: number | null = null;

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
   * Create a validated image element with error handling
   * Common helper for emoji, stickers, and author photos
   * SECURITY: Validates URL and creates element programmatically
   */
  private createImageElement(
    url: string,
    alt: string,
    className: string,
    sizePx: number
  ): HTMLImageElement | null {
    // Validate URL (defense in depth)
    if (!this.isValidImageUrl(url)) {
      console.warn('[YT Chat Overlay] Invalid image URL:', url);
      return null;
    }

    const img = document.createElement('img');
    img.src = url;
    img.alt = alt;
    img.className = className;
    img.style.height = `${sizePx}px`;
    img.style.width = 'auto'; // Maintain aspect ratio
    img.draggable = false;

    // Error handling: hide on load failure
    img.addEventListener(
      'error',
      () => {
        img.style.display = 'none';
        console.warn('[YT Chat Overlay] Failed to load image:', url);
      },
      { once: true }
    );

    return img;
  }

  /**
   * Create a standardized author photo element
   */
  private createAuthorPhotoElement(
    photoUrl: string | undefined,
    alt: string
  ): HTMLImageElement | null {
    if (!photoUrl) {
      return null;
    }

    return this.createImageElement(
      photoUrl,
      alt,
      'yt-chat-overlay-author-photo',
      LAYOUT.AUTHOR_PHOTO_SIZE
    );
  }

  /**
   * Create message text element (plain text or rich text + emoji)
   */
  private createMessageTextElement(
    message: ChatMessage,
    className = 'yt-chat-overlay-message-content'
  ): HTMLDivElement | null {
    const hasRichContent = Boolean(message.content && message.content.length > 0);
    const hasPlainText = message.text.trim().length > 0;

    if (!hasRichContent && !hasPlainText) {
      return null;
    }

    const contentDiv = document.createElement('div');
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
   * Resolve Super Chat RGB color from actual YouTube color or tier fallback
   */
  private resolveSuperChatRgb(superChat: SuperChatInfo): { r: number; g: number; b: number } {
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
  private createEmojiElement(emoji: EmojiInfo): HTMLImageElement | null {
    // Calculate size relative to font size
    const sizeFactor =
      emoji.type === 'member' ? LAYOUT.EMOJI_SIZE_MEMBER : LAYOUT.EMOJI_SIZE_STANDARD;
    const emojiSize = this.settings.fontSize * sizeFactor;

    // Create image element using common helper
    const img = this.createImageElement(
      emoji.url,
      emoji.alt || '',
      'yt-chat-overlay-emoji',
      emojiSize
    );

    if (!img) return null;

    // Apply emoji-specific styling
    img.style.display = 'inline-block';
    img.style.verticalAlign = 'text-bottom';

    // Add special styling for member emojis
    if (emoji.type === 'member') {
      img.classList.add('yt-chat-overlay-emoji-member');
    }

    return img;
  }

  /**
   * Create Super Chat sticker image element
   * SECURITY: Validates URL and creates element programmatically
   */
  private createSuperChatSticker(stickerUrl: string): HTMLImageElement | null {
    // Calculate size relative to font size
    const stickerSize = this.settings.fontSize * LAYOUT.SUPERCHAT_STICKER_SIZE;

    // Create image element using common helper
    return this.createImageElement(
      stickerUrl,
      'Super Chat Sticker',
      'yt-chat-overlay-superchat-sticker',
      stickerSize
    );
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
    const photoImg = this.createAuthorPhotoElement(
      message.authorPhotoUrl,
      message.author || 'Author'
    );
    if (photoImg) {
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
   * Create Super Chat header section with author info and amount badge
   */
  private createSuperChatHeader(
    message: ChatMessage,
    superChat: SuperChatInfo,
    showAuthor: boolean
  ): HTMLDivElement {
    const header = document.createElement('div');
    header.className = 'yt-chat-overlay-superchat-meta';

    if (showAuthor) {
      const authorSection = document.createElement('div');
      authorSection.className = 'yt-chat-overlay-superchat-author';

      const photoImg = this.createAuthorPhotoElement(
        message.authorPhotoUrl,
        message.author || 'Author'
      );
      if (photoImg) {
        authorSection.appendChild(photoImg);
      }

      if (message.author) {
        const authorName = document.createElement('span');
        authorName.className = 'yt-chat-overlay-author-name';
        authorName.textContent = message.author;

        // Set author color based on type
        const authorType = message.authorType || 'normal';
        authorName.style.color = this.settings.colors[authorType];

        authorSection.appendChild(authorName);
      }

      if (authorSection.childElementCount > 0) {
        header.appendChild(authorSection);
      }
    }

    // Amount badge
    const amountBadge = document.createElement('span');
    amountBadge.className = 'yt-chat-overlay-superchat-amount';
    amountBadge.textContent = superChat.amount;
    header.appendChild(amountBadge);

    if (!showAuthor) {
      header.style.justifyContent = 'flex-end';
    }

    return header;
  }

  /**
   * Create Super Chat content section with sticker and message
   */
  private createSuperChatContent(
    message: ChatMessage,
    superChat: SuperChatInfo
  ): HTMLDivElement | null {
    const hasSticker = Boolean(superChat.stickerUrl);
    const messageDiv = this.createMessageTextElement(message);

    if (!messageDiv && !hasSticker) {
      return null;
    }

    const content = document.createElement('div');
    content.className = 'yt-chat-overlay-superchat-body';

    // Add sticker if available (high-tier Super Chats)
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
  private createMembershipCard(message: ChatMessage): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'yt-chat-overlay-membership-card';

    // Author section with photo
    const authorSection = document.createElement('div');
    authorSection.className = 'yt-chat-overlay-membership-author';

    const photo = this.createAuthorPhotoElement(message.authorPhotoUrl, message.author || 'Member');
    if (photo) {
      authorSection.appendChild(photo);
    }

    const textContainer = document.createElement('div');
    textContainer.className = 'yt-chat-overlay-membership-text';

    // Author name
    if (message.author) {
      const authorName = document.createElement('div');
      authorName.className = 'yt-chat-overlay-membership-author-name';
      authorName.style.color = colors.author.member;
      authorName.textContent = message.author;
      textContainer.appendChild(authorName);
    }

    // Membership message
    const membershipText = this.createMessageTextElement(
      message,
      'yt-chat-overlay-membership-message'
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
  private applySuperChatStyling(element: HTMLDivElement, superChat: SuperChatInfo): void {
    element.classList.add('yt-chat-overlay-superchat-card');

    const rgb = this.resolveSuperChatRgb(superChat);
    const borderRgb = {
      r: Math.max(0, rgb.r - 36),
      g: Math.max(0, rgb.g - 36),
      b: Math.max(0, rgb.b - 36),
    };

    element.style.setProperty('--yt-sc-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    element.style.setProperty(
      '--yt-sc-border-rgb',
      `${borderRgb.r}, ${borderRgb.g}, ${borderRgb.b}`
    );
  }

  /**
   * Setup animation and positioning for a message element
   * Returns ActiveMessage object for tracking
   */
  private setupMessageAnimation(
    element: HTMLDivElement,
    placement: LanePlacement,
    textWidth: number,
    messageHeight: number,
    dimensions: OverlayDimensions
  ): ActiveMessage {
    const fontSize = this.settings.fontSize;
    const { lane, laneSpan } = placement;

    // Position element at the assigned lane
    const laneY = dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
    element.style.top = `${laneY}px`;
    element.style.visibility = 'visible';

    // Calculate animation duration and padding
    const exitPadding = Math.max(fontSize * LAYOUT.EXIT_PADDING_SCALE, LAYOUT.EXIT_PADDING_MIN);
    const distance = dimensions.width + textWidth + exitPadding;

    // Optimized duration for better pacing
    const effectiveSpeedPxPerSec = this.getEffectiveSpeedPxPerSec();
    const duration = Math.max(
      LAYOUT.DURATION_MIN,
      Math.min(LAYOUT.DURATION_MAX, (distance / effectiveSpeedPxPerSec) * 1000)
    );

    // Staggered lane delay for visual variety
    const laneDelay = (lane.index % LAYOUT.LANE_DELAY_CYCLE) * LAYOUT.LANE_DELAY_MS;
    const totalDuration = duration + laneDelay;

    // Create Web Animation
    const animation = element.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
      {
        duration,
        delay: laneDelay,
        easing: 'linear',
        fill: 'forwards',
      }
    );
    animation.playbackRate = this.playbackRate;

    // Update lane state with message dimensions
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

    // Auto-remove on animation end
    animation.addEventListener(
      'finish',
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
      animation,
    };
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

    this.messageQueue.push({
      message,
      nextAttemptAt: 0,
    });

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

    this.clearRetryTimer();

    let shortestWaitMs: number | null = null;

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

        // Soft cap warning (non-blocking)
        if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
          this.logPerformanceWarning();
        }

        const result = this.renderMessage(queued.message);

        if (result.status === 'rendered') {
          this.messageQueue.splice(i, 1);
          this.processedInLastSecond++;
          progressed = true;
          break;
        }

        if (result.status === 'dropped') {
          this.messageQueue.splice(i, 1);
          progressed = true;
          break;
        }

        queued.nextAttemptAt = now + result.waitMs;
        shortestWaitMs =
          shortestWaitMs === null ? result.waitMs : Math.min(shortestWaitMs, result.waitMs);
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
  private getEffectiveSpeedPxPerSec(): number {
    return Math.max(1, this.settings.speedPxPerSec * this.playbackRate);
  }

  /**
   * Schedule queue processing retry when lanes are temporarily occupied
   */
  private scheduleRetry(waitMs: number): void {
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
  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Log performance warning when concurrent message count is high
   * Limited to once per 10 seconds to avoid log spam
   */
  private logPerformanceWarning(): void {
    const now = Date.now();
    if (now - this.lastWarningTime < this.WARNING_INTERVAL_MS) {
      return;
    }

    this.lastWarningTime = now;
    console.warn(
      `[YT Chat Overlay] Performance warning: ${this.activeMessages.size} concurrent messages ` +
        `(recommended max: ${this.settings.maxConcurrentMessages}). ` +
        `Consider reducing maxMessagesPerSecond setting.`
    );
  }

  /**
   * Render a single message
   */
  private renderMessage(message: ChatMessage): RenderResult {
    const container = this.overlay.getContainer();
    const dimensions = this.overlay.getDimensions();
    if (!container || !dimensions) {
      console.warn('[YT Chat Overlay] Cannot render: container or dimensions missing');
      return { status: 'dropped' };
    }

    // Create message element
    const element = document.createElement('div');
    element.className = 'yt-chat-overlay-message';

    // Apply Super Chat styling if applicable
    const isSuperChat = message.kind === 'superchat' && message.superChat;
    const isMembership = message.kind === 'membership';

    if (isSuperChat && message.superChat) {
      // Apply card styling
      this.applySuperChatStyling(element, message.superChat);

      // Create structured header and content
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
    } else if (isMembership) {
      // Membership message
      const membershipCard = this.createMembershipCard(message);
      element.appendChild(membershipCard);
    } else {
      // Regular message (existing logic)
      const showAuthor = this.shouldShowAuthor(message);
      if (showAuthor) {
        element.classList.add('yt-chat-overlay-message-with-author');
      }

      if (showAuthor) {
        const authorElement = this.createAuthorElement(message);
        element.appendChild(authorElement);
      }

      const contentDiv = this.createMessageTextElement(message);
      if (!contentDiv) {
        console.warn('[YT Chat Overlay] Skipping empty message');
        return { status: 'dropped' };
      }

      element.appendChild(contentDiv);
    }

    // Font size is same for all messages
    const fontSize = this.settings.fontSize;
    element.style.fontSize = `${fontSize}px`;
    element.style.opacity = `${this.settings.opacity}`;

    // Apply color based on author type (unless it's a Super Chat or Membership with custom styling)
    if (!isSuperChat && !isMembership) {
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
    const placement = this.findLanePlacement(messageHeight, textWidth);
    if (placement === null) {
      // No available lane, drop message
      const dimensions = this.overlay.getDimensions();
      console.log(
        `[YT Chat Overlay] No available lane for message (height: ${messageHeight}px). ` +
          `Active messages: ${this.activeMessages.size}, Lanes: ${dimensions?.laneCount || 'unknown'}, ` +
          `Queue size: ${this.messageQueue.length}`
      );
      container.removeChild(element);
      return { status: 'dropped' };
    }

    if (placement.waitMs > 0) {
      container.removeChild(element);
      return { status: 'deferred', waitMs: placement.waitMs };
    }

    // Setup animation and positioning
    const activeMessage = this.setupMessageAnimation(
      element,
      placement,
      textWidth,
      messageHeight,
      dimensions
    );

    // Track active message
    this.activeMessages.add(activeMessage);

    console.log('[YT Chat Overlay] Rendering message:', {
      text: message.text.substring(0, 20),
      author: message.author,
      authorType: message.authorType || 'normal',
      kind: message.kind,
      isSuperChat,
      superChatTier: message.superChat?.tier,
      superChatAmount: message.superChat?.amount,
      color: isSuperChat ? 'tier-based' : this.settings.colors[message.authorType || 'normal'],
      lane: placement.lane.index,
      laneSpan: placement.laneSpan,
      width: textWidth,
      height: messageHeight,
      dimensions,
    });

    return { status: 'rendered' };
  }

  /**
   * Calculate required lane count for a message
   */
  private calculateRequiredLanes(messageHeight: number, laneHeight: number): number {
    const paddingPx = Math.max(
      LAYOUT.LANE_HEIGHT_PADDING_MIN,
      this.settings.fontSize * LAYOUT.LANE_HEIGHT_PADDING_SCALE
    );
    return Math.max(1, Math.ceil((messageHeight + paddingPx) / laneHeight));
  }

  /**
   * Calculate lane ready time for a new message width
   */
  private calculateLaneReadyTime(lane: LaneState, messageWidth: number, now: number): number {
    if (lane.lastItemStartTime <= 0) {
      return now;
    }

    const baseSafeDistance = this.settings.fontSize * LAYOUT.SAFE_DISTANCE_SCALE;
    const minSafeDistance = Math.max(baseSafeDistance, LAYOUT.SAFE_DISTANCE_MIN);
    const requiredGapPx =
      Math.max(lane.lastItemWidthPx, messageWidth, minSafeDistance) + minSafeDistance;
    const safeTimeGap = (requiredGapPx / this.getEffectiveSpeedPxPerSec()) * 1000;

    const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;
    const verticalReadyTime = lane.lastItemStartTime + LAYOUT.VERTICAL_CLEAR_TIME;

    return Math.max(now, horizontalReadyTime, verticalReadyTime);
  }

  /**
   * Find the best lane placement (position + timing)
   */
  private findLanePlacement(messageHeight: number, messageWidth: number): LanePlacement | null {
    const now = Date.now();
    const dimensions = this.overlay.getDimensions();
    if (!dimensions) return null;

    const requiredLanes = this.calculateRequiredLanes(messageHeight, dimensions.laneHeight);
    if (requiredLanes > this.lanes.length) {
      return null;
    }

    let bestLane: LaneState | null = null;
    let bestReadyTime = Number.POSITIVE_INFINITY;

    for (let i = 0; i <= this.lanes.length - requiredLanes; i++) {
      let blockReadyTime = now;

      for (let offset = 0; offset < requiredLanes; offset++) {
        const lane = this.lanes[i + offset];
        if (!lane) {
          blockReadyTime = Number.POSITIVE_INFINITY;
          break;
        }

        const laneReadyTime = this.calculateLaneReadyTime(lane, messageWidth, now);
        blockReadyTime = Math.max(blockReadyTime, laneReadyTime);
      }

      if (
        blockReadyTime < bestReadyTime ||
        (blockReadyTime === bestReadyTime && bestLane && i < bestLane.index)
      ) {
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
      waitMs: Math.max(0, Math.ceil(bestReadyTime - now)),
    };
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
    try {
      if (active.animation.playState !== 'finished') {
        active.animation.cancel();
      }
    } catch {
      // Ignore animation cancellation errors during cleanup
    }

    if (active.element.parentNode) {
      active.element.parentNode.removeChild(active.element);
    }
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
    this.pausedAt = Date.now();
    this.clearRetryTimer();
    this.forEachAnimation((animation) => animation.pause());
    console.log(`[Renderer] Paused ${this.activeMessages.size} animations`);
  }

  /**
   * Resume all active animations and process queued messages
   */
  resume(): void {
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
  destroy(): void {
    this.isPaused = false;
    this.clear();
    if (this.styleElement?.parentNode) {
      this.styleElement.parentNode.removeChild(this.styleElement);
    }
    this.styleElement = null;
  }
}
