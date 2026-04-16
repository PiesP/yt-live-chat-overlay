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
import { isAllowedYouTubeImageUrl } from '@core/image-url';
import { overlayLog } from '@core/logging';
import { clearTimeoutHandle } from '@core/timers';
import {
  borderRadius,
  colors,
  parseRgbColor,
  type RgbColor,
  rgba,
  shadows,
  spacing,
  typography,
} from './design-tokens.js';
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

interface BuiltMessage {
  element: HTMLDivElement;
  isSuperChat: boolean;
  isMembership: boolean;
}

interface RenderContext {
  container: HTMLDivElement;
  dimensions: OverlayDimensions;
}

interface AuthorNameOptions {
  className?: string;
  color?: string;
  tagName?: 'span' | 'div';
}

interface RendererUpdateOptions {
  resetState?: boolean;
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
  LANE_DELAY_CYCLE: 3, // number of lanes before repeating delay pattern
  LANE_DELAY_MS: 15, // ms per lane cycle (reduced from 40 for faster throughput)

  // Collision detection
  // Safe distance = minimum pixel gap between messages in the same lane.
  // Reduced from 0.7/16 → 0.5/10 → 0.3/6 for tighter horizontal packing
  // while still preventing visual overlap at all supported font sizes.
  SAFE_DISTANCE_SCALE: 0.3, // relative to fontSize
  SAFE_DISTANCE_MIN: 6, // px
  // Vertical clear time guards the brief window while the previous message
  // is still partially behind the screen's right edge.  Reduced from
  // 120/320 ms → 40/160 ms → 20/80 ms for faster lane turnover; the
  // horizontal readiness check already dominates for messages wider than ~30 px.
  VERTICAL_CLEAR_TIME_MIN: 20, // ms
  VERTICAL_CLEAR_TIME_MAX: 80, // ms
  LANE_HEIGHT_PADDING_SCALE: 0.06, // relative to fontSize
  LANE_HEIGHT_PADDING_MIN: 1, // px
  RETRY_DELAY_MIN_MS: 16, // ms
  RETRY_DELAY_MAX_MS: 800, // ms
  QUEUE_LOOKAHEAD_LIMIT: 20, // queue scan window for scheduling (increased from 14)
  QUEUE_MAX_SIZE: 150, // max queued messages; oldest dropped on overflow
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
  private overlayDimensionsUnsubscribe: (() => void) | null = null;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.initLanes();
    this.injectStyles();
    this.overlayDimensionsUnsubscribe = this.overlay.onDimensionsChanged((dimensions) => {
      this.handleOverlayDimensionsChange(dimensions);
    });
  }

  /**
   * Initialize lanes
   */
  private initLanes(): void {
    const dimensions = this.overlay.getDimensions();
    if (!dimensions) {
      this.lanes = [];
      return;
    }

    this.lanes = Array.from({ length: dimensions.laneCount }, (_, i) => ({
      index: i,
      lastItemExitTime: 0,
      lastItemStartTime: 0,
      lastItemWidthPx: 0,
      lastItemHeightPx: 0,
    }));
  }

  private resetRenderedState(): void {
    this.clearRetryTimer();

    for (const active of Array.from(this.activeMessages)) {
      this.removeMessage(active);
    }

    this.activeMessages.clear();
    this.messageQueue = [];
  }

  private handleOverlayDimensionsChange(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.resetRenderedState();
      this.lanes = [];
      return;
    }

    if (this.activeMessages.size > 0) {
      this.resetRenderedState();
      this.initLanes();
      return;
    }

    this.initLanes();

    if (!this.isPaused && this.messageQueue.length > 0) {
      this.processQueue();
    }
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
        /* Explicit line-height keeps rendered element height at fontSize × 1.1.
           This is required for single-line messages to fit in exactly 1 lane
           slot when BASE_LANE_HEIGHT_MULTIPLIER = 1.2. */
        line-height: 1.1;
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
    if (!isAllowedYouTubeImageUrl(url)) {
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

  private createContainer(className: string): HTMLDivElement {
    const element = document.createElement('div');
    element.className = className;
    return element;
  }

  private getAuthorType(message: ChatMessage): NonNullable<ChatMessage['authorType']> {
    return message.authorType || 'normal';
  }

  private createAuthorPhoto(message: ChatMessage, fallbackAlt = 'Author'): HTMLImageElement | null {
    return this.createAuthorPhotoElement(message.authorPhotoUrl, message.author || fallbackAlt);
  }

  private createAuthorNameElement(
    message: ChatMessage,
    options: AuthorNameOptions = {}
  ): HTMLElement | null {
    if (!message.author) {
      return null;
    }

    const { className = 'yt-chat-overlay-author-name', tagName = 'span' } = options;
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = message.author;
    element.style.color = options.color ?? this.settings.colors[this.getAuthorType(message)];
    return element;
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

    const contentDiv = this.createContainer(className);

    if (hasRichContent && message.content) {
      this.renderMixedContent(contentDiv, message.content);
    } else {
      contentDiv.textContent = message.text;
    }

    return contentDiv;
  }

  /**
   * Resolve Super Chat RGB color from actual YouTube color or tier fallback
   */
  private resolveSuperChatRgb(superChat: SuperChatInfo): RgbColor {
    const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
    const parsed = sourceColor ? parseRgbColor(sourceColor) : null;

    if (parsed) {
      return parsed;
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
    return settings[this.getAuthorType(message)];
  }

  /**
   * Create author info element (photo + name)
   * SECURITY: Validates photo URL and creates elements programmatically
   */
  private createAuthorElement(message: ChatMessage): HTMLDivElement {
    const authorInfoDiv = this.createContainer('yt-chat-overlay-author-info');

    // Add author photo if available
    const photoImg = this.createAuthorPhoto(message);
    if (photoImg) {
      authorInfoDiv.appendChild(photoImg);
    }

    // Add author name
    const nameSpan = this.createAuthorNameElement(message);
    if (nameSpan) {
      authorInfoDiv.appendChild(nameSpan);
    }

    return authorInfoDiv;
  }

  private createSuperChatAmountBadge(amount: string): HTMLSpanElement {
    const amountBadge = document.createElement('span');
    amountBadge.className = 'yt-chat-overlay-superchat-amount';
    amountBadge.textContent = amount;
    return amountBadge;
  }

  /**
   * Create Super Chat header section with author info and amount badge
   */
  private createSuperChatHeader(
    message: ChatMessage,
    superChat: SuperChatInfo,
    showAuthor: boolean
  ): HTMLDivElement {
    const header = this.createContainer('yt-chat-overlay-superchat-meta');

    if (showAuthor) {
      const authorSection = this.createContainer('yt-chat-overlay-superchat-author');

      const photoImg = this.createAuthorPhoto(message);
      if (photoImg) {
        authorSection.appendChild(photoImg);
      }

      const authorName = this.createAuthorNameElement(message);
      if (authorName) {
        authorSection.appendChild(authorName);
      }

      if (authorSection.childElementCount > 0) {
        header.appendChild(authorSection);
      }
    }

    // Amount badge
    header.appendChild(this.createSuperChatAmountBadge(superChat.amount));

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

    const content = this.createContainer('yt-chat-overlay-superchat-body');

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
    const card = this.createContainer('yt-chat-overlay-membership-card');

    // Author section with photo
    const authorSection = this.createContainer('yt-chat-overlay-membership-author');

    const photo = this.createAuthorPhoto(message, 'Member');
    if (photo) {
      authorSection.appendChild(photo);
    }

    const textContainer = this.createContainer('yt-chat-overlay-membership-text');

    // Author name
    const authorName = this.createAuthorNameElement(message, {
      className: 'yt-chat-overlay-membership-author-name',
      color: colors.author.member,
      tagName: 'div',
    });
    if (authorName) {
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

  private buildRegularMessageElement(message: ChatMessage): BuiltMessage | null {
    const element = this.createContainer('yt-chat-overlay-message');
    const showAuthor = this.shouldShowAuthor(message);

    if (showAuthor) {
      element.classList.add('yt-chat-overlay-message-with-author');
      element.appendChild(this.createAuthorElement(message));
    }

    const contentDiv = this.createMessageTextElement(message);
    if (!contentDiv) {
      console.warn('[YT Chat Overlay] Skipping empty message');
      return null;
    }

    element.appendChild(contentDiv);
    return { element, isSuperChat: false, isMembership: false };
  }

  private buildSuperChatElement(message: ChatMessage, superChat: SuperChatInfo): BuiltMessage {
    const element = this.createContainer('yt-chat-overlay-message');
    this.applySuperChatStyling(element, superChat);

    const headerElement = this.createSuperChatHeader(
      message,
      superChat,
      this.settings.showAuthor.superChat
    );
    const contentElement = this.createSuperChatContent(message, superChat);

    element.appendChild(headerElement);
    if (contentElement) {
      element.appendChild(contentElement);
    }

    return { element, isSuperChat: true, isMembership: false };
  }

  private buildMembershipElement(message: ChatMessage): BuiltMessage {
    const element = this.createContainer('yt-chat-overlay-message');
    element.appendChild(this.createMembershipCard(message));
    return { element, isSuperChat: false, isMembership: true };
  }

  private getRenderContext(): RenderContext | null {
    const container = this.overlay.getContainer();
    const dimensions = this.overlay.getDimensions();

    if (!container || !dimensions) {
      return null;
    }

    return { container, dimensions };
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

    // Small random jitter so messages entering around the same time don't
    // align into a visible diagonal staircase.
    const laneDelay = Math.floor(Math.random() * LAYOUT.LANE_DELAY_CYCLE * LAYOUT.LANE_DELAY_MS);
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

    // Also remove if animation is cancelled externally (e.g. element removed from DOM)
    animation.addEventListener(
      'cancel',
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

    // Drop oldest entries if queue is full to prevent animation flood after long pause
    if (this.messageQueue.length >= LAYOUT.QUEUE_MAX_SIZE) {
      const excess = this.messageQueue.length - LAYOUT.QUEUE_MAX_SIZE + 1;
      this.messageQueue.splice(0, excess);
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
    this.retryTimer = clearTimeoutHandle(this.retryTimer);
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
   * Build message DOM element by message kind
   */
  private buildMessageElement(message: ChatMessage): BuiltMessage | null {
    if (message.kind === 'superchat' && message.superChat) {
      return this.buildSuperChatElement(message, message.superChat);
    }

    if (message.kind === 'membership') {
      return this.buildMembershipElement(message);
    }

    return this.buildRegularMessageElement(message);
  }

  /**
   * Apply common visual styles shared by all message kinds
   */
  private applyCommonMessageStyles(
    element: HTMLDivElement,
    message: ChatMessage,
    isSuperChat: boolean,
    isMembership: boolean
  ): void {
    element.style.fontSize = `${this.settings.fontSize}px`;
    element.style.opacity = `${this.settings.opacity}`;

    // Apply author color only for regular messages
    if (!isSuperChat && !isMembership) {
      element.style.color = this.settings.colors[this.getAuthorType(message)];
    }
  }

  /**
   * Append message to DOM in hidden state and measure rendered size
   */
  private measureMessageElement(
    container: HTMLDivElement,
    element: HTMLDivElement,
    overlayWidth: number
  ): { textWidth: number; messageHeight: number } {
    element.style.visibility = 'hidden';
    element.style.left = `${overlayWidth}px`;
    element.style.top = '0px';
    container.appendChild(element);

    return {
      textWidth: element.offsetWidth,
      messageHeight: element.offsetHeight,
    };
  }

  /**
   * Render a single message
   */
  private renderMessage(message: ChatMessage): RenderResult {
    const renderContext = this.getRenderContext();
    if (!renderContext) {
      console.warn('[YT Chat Overlay] Cannot render: container or dimensions missing');
      return { status: 'dropped' };
    }

    const { container, dimensions } = renderContext;

    const builtMessage = this.buildMessageElement(message);
    if (!builtMessage) {
      return { status: 'dropped' };
    }

    const { element, isSuperChat, isMembership } = builtMessage;
    this.applyCommonMessageStyles(element, message, isSuperChat, isMembership);

    // Add in hidden state and measure actual rendered dimensions
    const { textWidth, messageHeight } = this.measureMessageElement(
      container,
      element,
      dimensions.width
    );

    // Find available lane based on message height
    const placement = this.findLanePlacement(messageHeight);
    if (placement === null) {
      // No available lane, drop message
      overlayLog.info(
        `[YT Chat Overlay] No available lane for message (height: ${messageHeight}px). ` +
          `Active messages: ${this.activeMessages.size}, Lanes: ${dimensions.laneCount}, ` +
          `Queue size: ${this.messageQueue.length}`
      );
      element.remove();
      return { status: 'dropped' };
    }

    if (placement.waitMs > 0) {
      element.remove();
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

    overlayLog.info('[YT Chat Overlay] Rendering message:', {
      text: message.text.substring(0, 20),
      author: message.author,
      authorType: this.getAuthorType(message),
      kind: message.kind,
      isSuperChat,
      superChatTier: message.superChat?.tier,
      superChatAmount: message.superChat?.amount,
      color: isSuperChat ? 'tier-based' : this.settings.colors[this.getAuthorType(message)],
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
  private calculateLaneReadyTime(lane: LaneState, now: number): number {
    if (lane.lastItemStartTime <= 0) {
      return now;
    }

    const baseSafeDistance = this.settings.fontSize * LAYOUT.SAFE_DISTANCE_SCALE;
    const minSafeDistance = Math.max(baseSafeDistance, LAYOUT.SAFE_DISTANCE_MIN);

    // Same-lane messages move at the same speed, so overlap is governed mainly by
    // previous message width + a small visual buffer (new width does not shrink gap).
    const requiredGapPx = lane.lastItemWidthPx + minSafeDistance;
    const safeTimeGap = (requiredGapPx / this.getEffectiveSpeedPxPerSec()) * 1000;

    const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;
    const verticalClearTime = Math.min(
      LAYOUT.VERTICAL_CLEAR_TIME_MAX,
      Math.max(LAYOUT.VERTICAL_CLEAR_TIME_MIN, lane.lastItemHeightPx * 4)
    );
    const verticalReadyTime = lane.lastItemStartTime + verticalClearTime;

    return Math.max(now, horizontalReadyTime, verticalReadyTime);
  }

  /**
   * Find the best lane placement (position + timing).
   *
   * Selection strategy: collect all valid candidate blocks with their ready
   * times, then pick **randomly** from those that are immediately available
   * (readyTime <= now).  This prevents the staircase / diagonal pattern that
   * arises when messages are placed in top-to-bottom sequential order during
   * chat bursts.  When no lane is ready right now, pick randomly among the
   * soonest-available group so the wait time is minimised while still
   * avoiding visual clustering.
   */
  private findLanePlacement(messageHeight: number): LanePlacement | null {
    const now = Date.now();
    const dimensions = this.overlay.getDimensions();
    if (!dimensions) return null;

    const requiredLanes = this.calculateRequiredLanes(messageHeight, dimensions.laneHeight);
    if (requiredLanes > this.lanes.length) {
      return null;
    }

    interface BlockCandidate {
      startIndex: number;
      readyTime: number;
    }

    const candidates: BlockCandidate[] = [];
    let minReadyTime = Number.POSITIVE_INFINITY;

    for (let i = 0; i <= this.lanes.length - requiredLanes; i++) {
      let blockReadyTime = now;

      for (let offset = 0; offset < requiredLanes; offset++) {
        const lane = this.lanes[i + offset];
        if (!lane) {
          blockReadyTime = Number.POSITIVE_INFINITY;
          break;
        }
        blockReadyTime = Math.max(blockReadyTime, this.calculateLaneReadyTime(lane, now));
      }

      if (!Number.isFinite(blockReadyTime)) continue;

      candidates.push({ startIndex: i, readyTime: blockReadyTime });
      minReadyTime = Math.min(minReadyTime, blockReadyTime);
    }

    if (candidates.length === 0 || !Number.isFinite(minReadyTime)) {
      return null;
    }

    // Prefer lanes that are ready right now; fall back to the soonest group.
    const readyNow = candidates.filter((c) => c.readyTime <= now);
    const pool =
      readyNow.length > 0 ? readyNow : candidates.filter((c) => c.readyTime === minReadyTime);

    // Random pick breaks the top-to-bottom sequential assignment pattern.
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    if (!chosen) return null;

    const chosenLane = this.lanes[chosen.startIndex];
    if (!chosenLane) return null;

    return {
      lane: chosenLane,
      laneSpan: requiredLanes,
      waitMs: Math.max(0, Math.ceil(chosen.readyTime - now)),
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
    this.activeMessages.delete(active);

    try {
      if (active.animation.playState !== 'finished') {
        active.animation.cancel();
      }
    } catch {
      // Ignore animation cancellation errors during cleanup
    }

    if (active.element.parentNode) {
      active.element.remove();
    }
  }

  /**
   * Update settings
   */
  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    this.settings = settings;
    this.injectStyles();

    if (options.resetState) {
      this.resetForResync();
      return;
    }

    if (this.lanes.length === 0) {
      this.initLanes();
    }
  }

  /**
   * Pause all active animations
   */
  pause(): void {
    if (this.isPaused) return;

    overlayLog.info('[Renderer] Pausing all animations');
    this.isPaused = true;
    this.pausedAt = Date.now();
    this.clearRetryTimer();
    this.forEachAnimation((animation) => animation.pause());
    overlayLog.info(`[Renderer] Paused ${this.activeMessages.size} animations`);
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

    overlayLog.info('[Renderer] Resuming all animations');
    this.isPaused = false;
    this.forEachAnimation((animation) => animation.play());
    overlayLog.info(`[Renderer] Resumed ${this.activeMessages.size} animations`);

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
   * Discard all queued (not yet rendered) messages.
   * Called on seek to prevent stale messages from appearing after a position change.
   */
  flushQueue(): void {
    this.messageQueue = [];
    this.clearRetryTimer();
  }

  /**
   * Reset rendered/queued message state for chat resynchronization.
   * Keeps renderer instance and playbackRate, but clears visual backlog so
   * only fresh synchronized messages are shown.
   */
  resetForResync(): void {
    this.resetRenderedState();
    this.initLanes();
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

    overlayLog.info(
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
    this.resetRenderedState();
    this.pausedAt = null;
    this.playbackRate = 1;
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    // Clear state
    this.isPaused = false;
    this.overlayDimensionsUnsubscribe?.();
    this.overlayDimensionsUnsubscribe = null;

    // Clear all active messages and queue
    this.clear();

    // Remove style element
    this.styleElement?.remove();
    this.styleElement = null;

    overlayLog.info('[Renderer] Destroyed');
  }
}
