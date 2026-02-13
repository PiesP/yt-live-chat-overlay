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
import {
  borderRadius,
  colors,
  createGradient,
  rgba,
  shadows,
  spacing,
  typography,
} from './design-tokens.js';
import type { Overlay } from './overlay';

interface ActiveMessage {
  element: HTMLDivElement;
  lane: number;
  startTime: number;
  duration: number;
  timeoutId: number;
  animation: Animation;
}

/**
 * Layout and styling constants
 */
const LAYOUT = {
  // Author display
  AUTHOR_PHOTO_SIZE: 24, // px
  AUTHOR_FONT_SCALE: 0.85, // relative to base fontSize
  AUTHOR_CONTENT_GAP: 4, // px

  // Emoji sizing
  EMOJI_SIZE_STANDARD: 1.2, // relative to base fontSize
  EMOJI_SIZE_MEMBER: 1.4, // relative to base fontSize

  // Super Chat
  SUPERCHAT_PADDING: 8, // px (vertical and horizontal)
  SUPERCHAT_STICKER_SIZE: 2.0, // relative to base fontSize
  SUPERCHAT_BORDER_WIDTH: 3, // px

  // Animation
  EXIT_PADDING_MIN: 100, // px
  EXIT_PADDING_SCALE: 3, // relative to fontSize
  DURATION_MIN: 5000, // ms
  DURATION_MAX: 12000, // ms
  LANE_DELAY_CYCLE: 4, // number of lanes before repeating delay pattern
  LANE_DELAY_MS: 100, // ms per lane cycle
  CLEANUP_BUFFER: 2000, // ms

  // Collision detection
  SAFE_DISTANCE_SCALE: 2, // relative to fontSize
  SAFE_DISTANCE_MIN: 100, // px
  VERTICAL_CLEAR_TIME: 800, // ms
} as const;

export class Renderer {
  private overlay: Overlay;
  private settings: OverlaySettings;
  private lanes: LaneState[] = [];
  private activeMessages: Set<ActiveMessage> = new Set();
  private messageQueue: ChatMessage[] = [];
  private lastProcessTime = 0;
  private processedInLastSecond = 0;
  private isPaused = false;
  private lastWarningTime = 0;
  private readonly WARNING_INTERVAL_MS = 10000;
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

      /* === YOUTUBE-STYLE SUPER CHAT CARD === */

      /* Card container */
      .yt-chat-overlay-superchat-card {
        display: flex;
        flex-direction: column;
        border-radius: ${borderRadius.md};
        overflow: hidden;
        box-shadow: ${shadows.box.md};
        backdrop-filter: blur(4px);
      }

      /* Header section */
      .yt-chat-overlay-superchat-header {
        position: relative;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: ${spacing.sm}px ${spacing.md}px;
        min-height: 40px;
        background: transparent;
      }

      .yt-chat-overlay-superchat-header-left {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
        flex: 1;
        min-width: 0;
      }

      .yt-chat-overlay-superchat-header-right {
        display: flex;
        align-items: center;
        gap: ${spacing.md}px;
        flex-shrink: 0;
        margin-left: ${spacing.md}px;
      }

      /* Header author inline */
      .yt-chat-overlay-author-info-inline {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
        min-width: 0;
      }

      .yt-chat-overlay-author-info-inline .yt-chat-overlay-author-name {
        font-size: 0.85em;
        font-weight: ${typography.fontWeight.bold};
        text-shadow: ${shadows.text.sm};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Enhanced amount badge */
      .yt-chat-overlay-superchat-amount-badge {
        display: inline-flex;
        align-items: center;
        padding: ${spacing.xs}px ${spacing.lg}px;
        border-radius: ${borderRadius.xl};
        font-weight: ${typography.fontWeight.bold};
        font-size: 0.85em;
        white-space: nowrap;
        box-shadow: ${shadows.box.sm}, inset 0 1px 0 rgba(255, 255, 255, 0.2);
        text-shadow: ${shadows.text.sm};
        letter-spacing: 0.3px;
      }

      /* Timestamp */
      .yt-chat-overlay-superchat-timestamp {
        font-size: 0.75em;
        font-weight: ${typography.fontWeight.semibold};
        opacity: 0.85;
        color: rgba(255, 255, 255, 0.9);
        text-shadow: ${shadows.text.sm};
        white-space: nowrap;
      }

      /* Content section */
      .yt-chat-overlay-superchat-content {
        display: flex;
        flex-direction: column;
        padding: ${spacing.md}px ${spacing.md}px;
        gap: ${spacing.sm}px;
        background: transparent;
      }

      .yt-chat-overlay-superchat-content .yt-chat-overlay-message-content {
        font-size: 1em;
        line-height: ${typography.lineHeight.normal};
        text-shadow: ${shadows.text.md};
        letter-spacing: 0.2px;
      }

      .yt-chat-overlay-superchat-content .yt-chat-overlay-superchat-sticker {
        align-self: flex-start;
        margin-bottom: ${spacing.xs}px;
      }

      /* Tier-specific gradients (7 tiers) - applied to card for seamless appearance */
      .yt-chat-overlay-superchat-tier-blue {
        background: ${createGradient(colors.superChat.blue, [0.75, 0.5, 0.35, 0.25])};
      }

      .yt-chat-overlay-superchat-tier-cyan {
        background: ${createGradient(colors.superChat.cyan, [0.75, 0.5, 0.35, 0.25])};
      }

      .yt-chat-overlay-superchat-tier-green {
        background: ${createGradient(colors.superChat.green, [0.75, 0.5, 0.35, 0.25])};
      }

      .yt-chat-overlay-superchat-tier-yellow {
        background: ${createGradient(colors.superChat.yellow, [0.75, 0.5, 0.35, 0.25])};
      }

      .yt-chat-overlay-superchat-tier-orange {
        background: ${createGradient(colors.superChat.orange, [0.75, 0.5, 0.35, 0.25])};
      }

      .yt-chat-overlay-superchat-tier-magenta {
        background: ${createGradient(colors.superChat.magenta, [0.75, 0.5, 0.35, 0.25])};
      }

      .yt-chat-overlay-superchat-tier-red {
        background: ${createGradient(colors.superChat.red, [0.75, 0.5, 0.35, 0.25])};
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

      /* Super Chat styling */
      .yt-chat-overlay-message-superchat {
        padding: ${LAYOUT.SUPERCHAT_PADDING}px ${LAYOUT.SUPERCHAT_PADDING * 2}px;
        border-radius: ${borderRadius.md};
        background: rgba(0, 0, 0, 0.4);
        box-shadow: ${shadows.box.md};
        border: ${LAYOUT.SUPERCHAT_BORDER_WIDTH}px solid rgba(255, 255, 255, 0.9);
      }

      /* Super Chat amount badge */
      .yt-chat-overlay-superchat-amount {
        display: inline-block;
        padding: ${spacing.xs}px ${spacing.md}px;
        margin-right: ${spacing.md}px;
        border-radius: ${borderRadius.lg};
        font-weight: ${typography.fontWeight.bold};
        font-size: 0.9em;
        vertical-align: middle;
        box-shadow: ${shadows.box.sm};
      }

      /* Super Chat sticker */
      .yt-chat-overlay-superchat-sticker {
        display: inline-block;
        vertical-align: middle;
        margin-right: ${spacing.sm}px;
        filter: ${shadows.filter.md};
      }

      /* Super Chat tier colors */
      .yt-chat-overlay-superchat-blue {
        border-color: rgb(${colors.superChat.blue.r}, ${colors.superChat.blue.g}, ${colors.superChat.blue.b});
        background: ${rgba(colors.superChat.blue, 0.4)};
      }
      .yt-chat-overlay-superchat-cyan {
        border-color: rgb(${colors.superChat.cyan.r}, ${colors.superChat.cyan.g}, ${colors.superChat.cyan.b});
        background: ${rgba(colors.superChat.cyan, 0.4)};
      }
      .yt-chat-overlay-superchat-green {
        border-color: rgb(${colors.superChat.green.r}, ${colors.superChat.green.g}, ${colors.superChat.green.b});
        background: ${rgba(colors.superChat.green, 0.4)};
      }
      .yt-chat-overlay-superchat-yellow {
        border-color: rgb(${colors.superChat.yellow.r}, ${colors.superChat.yellow.g}, ${colors.superChat.yellow.b});
        background: ${rgba(colors.superChat.yellow, 0.4)};
      }
      .yt-chat-overlay-superchat-orange {
        border-color: rgb(${colors.superChat.orange.r}, ${colors.superChat.orange.g}, ${colors.superChat.orange.b});
        background: ${rgba(colors.superChat.orange, 0.4)};
      }
      .yt-chat-overlay-superchat-magenta {
        border-color: rgb(${colors.superChat.magenta.r}, ${colors.superChat.magenta.g}, ${colors.superChat.magenta.b});
        background: ${rgba(colors.superChat.magenta, 0.4)};
      }
      .yt-chat-overlay-superchat-red {
        border-color: rgb(${colors.superChat.red.r}, ${colors.superChat.red.g}, ${colors.superChat.red.b});
        background: ${rgba(colors.superChat.red, 0.4)};
      }

      /* Super Chat amount badge tier colors */
      .yt-chat-overlay-superchat-amount-blue { background-color: rgb(${colors.superChat.blue.r}, ${colors.superChat.blue.g}, ${colors.superChat.blue.b}); }
      .yt-chat-overlay-superchat-amount-cyan { background-color: rgb(${colors.superChat.cyan.r}, ${colors.superChat.cyan.g}, ${colors.superChat.cyan.b}); }
      .yt-chat-overlay-superchat-amount-green { background-color: rgb(${colors.superChat.green.r}, ${colors.superChat.green.g}, ${colors.superChat.green.b}); }
      .yt-chat-overlay-superchat-amount-yellow { background-color: rgb(${colors.superChat.yellow.r}, ${colors.superChat.yellow.g}, ${colors.superChat.yellow.b}); color: #000; }
      .yt-chat-overlay-superchat-amount-orange { background-color: rgb(${colors.superChat.orange.r}, ${colors.superChat.orange.g}, ${colors.superChat.orange.b}); }
      .yt-chat-overlay-superchat-amount-magenta { background-color: rgb(${colors.superChat.magenta.r}, ${colors.superChat.magenta.g}, ${colors.superChat.magenta.b}); }
      .yt-chat-overlay-superchat-amount-red { background-color: rgb(${colors.superChat.red.r}, ${colors.superChat.red.g}, ${colors.superChat.red.b}); }

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
   * Create rgba color with specified alpha value
   * Converts any rgb/rgba color to rgba with new alpha
   */
  private createRgbaWithAlpha(colorString: string, alpha: number): string {
    const parsed = this.parseRgbaColor(colorString);
    if (!parsed) {
      // Fallback to semi-transparent black
      return `rgba(0, 0, 0, ${alpha})`;
    }

    return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
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
    if (message.authorPhotoUrl) {
      const photoImg = this.createImageElement(
        message.authorPhotoUrl,
        message.author || 'Author',
        'yt-chat-overlay-author-photo',
        LAYOUT.AUTHOR_PHOTO_SIZE
      );

      if (photoImg) {
        authorInfoDiv.appendChild(photoImg);
      }
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
  private createSuperChatHeader(message: ChatMessage, superChat: SuperChatInfo): HTMLDivElement {
    const header = document.createElement('div');
    header.className = 'yt-chat-overlay-superchat-header';

    // Left section: author photo + name
    const leftSection = document.createElement('div');
    leftSection.className = 'yt-chat-overlay-superchat-header-left';

    // Always show author in Super Chat header
    if (message.authorPhotoUrl) {
      const photoImg = document.createElement('img');
      photoImg.className = 'yt-chat-overlay-author-photo';
      photoImg.src = message.authorPhotoUrl;
      photoImg.alt = message.author || 'Author';
      leftSection.appendChild(photoImg);
    }

    if (message.author) {
      const authorInfoInline = document.createElement('div');
      authorInfoInline.className = 'yt-chat-overlay-author-info-inline';

      const authorName = document.createElement('span');
      authorName.className = 'yt-chat-overlay-author-name';
      authorName.textContent = message.author;

      // Set author color based on type
      const authorType = message.authorType || 'normal';
      authorName.style.color = this.settings.colors[authorType];

      authorInfoInline.appendChild(authorName);
      leftSection.appendChild(authorInfoInline);
    }

    header.appendChild(leftSection);

    // Right section: amount badge + timestamp
    const rightSection = document.createElement('div');
    rightSection.className = 'yt-chat-overlay-superchat-header-right';

    // Amount badge
    const amountBadge = document.createElement('span');
    amountBadge.className = 'yt-chat-overlay-superchat-amount-badge';
    amountBadge.textContent = superChat.amount;

    // Apply badge color
    const badgeColor = superChat.headerBackgroundColor || superChat.backgroundColor;
    if (badgeColor) {
      amountBadge.style.backgroundColor = badgeColor;
      const isLight = this.isLightColor(badgeColor);
      amountBadge.style.color = isLight ? '#000' : '#fff';
    } else {
      amountBadge.classList.add(`yt-chat-overlay-superchat-amount-${superChat.tier}`);
    }

    rightSection.appendChild(amountBadge);

    header.appendChild(rightSection);

    return header;
  }

  /**
   * Create Super Chat content section with sticker and message
   */
  private createSuperChatContent(message: ChatMessage, superChat: SuperChatInfo): HTMLDivElement {
    const content = document.createElement('div');
    content.className = 'yt-chat-overlay-superchat-content';

    // Add sticker if available (high-tier Super Chats)
    if (superChat.stickerUrl) {
      const stickerImg = this.createSuperChatSticker(superChat.stickerUrl);
      if (stickerImg) {
        content.appendChild(stickerImg);
      }
    }

    // Message content
    const messageDiv = document.createElement('div');
    messageDiv.className = 'yt-chat-overlay-message-content';

    if (message.content && message.content.length > 0) {
      this.renderMixedContent(messageDiv, message.content);
    } else {
      messageDiv.textContent = message.text;
    }

    content.appendChild(messageDiv);

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

    if (message.authorPhotoUrl) {
      const photo = document.createElement('img');
      photo.className = 'yt-chat-overlay-author-photo';
      photo.src = message.authorPhotoUrl;
      photo.alt = message.author || 'Member';
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
    const membershipText = document.createElement('div');
    membershipText.className = 'yt-chat-overlay-membership-message';

    if (message.content && message.content.length > 0) {
      this.renderMixedContent(membershipText, message.content);
    } else {
      membershipText.textContent = message.text;
    }

    textContainer.appendChild(membershipText);
    authorSection.appendChild(textContainer);
    card.appendChild(authorSection);

    return card;
  }

  /**
   * Apply Super Chat card styling with tier class
   */
  private applySuperChatStyling(element: HTMLDivElement, superChat: SuperChatInfo): void {
    element.classList.add('yt-chat-overlay-superchat-card');

    // Apply tier class for gradient styling
    element.classList.add(`yt-chat-overlay-superchat-tier-${superChat.tier}`);

    // If actual YouTube colors available, override with inline styles
    if (superChat.backgroundColor) {
      const headerBg = superChat.headerBackgroundColor || superChat.backgroundColor;

      // Will be applied to header and content after they're created
      element.setAttribute('data-header-color', headerBg);
      element.setAttribute('data-content-color', superChat.backgroundColor);

      console.log('[YT Chat Overlay] Using actual YouTube colors:', {
        header: headerBg,
        content: superChat.backgroundColor,
      });
    } else {
      console.log('[YT Chat Overlay] Using tier gradients:', superChat.tier);
    }
  }

  /**
   * Setup animation and positioning for a message element
   * Returns ActiveMessage object for tracking
   */
  private setupMessageAnimation(
    element: HTMLDivElement,
    lane: LaneState,
    textWidth: number,
    messageHeight: number,
    dimensions: OverlayDimensions
  ): ActiveMessage {
    const fontSize = this.settings.fontSize;

    // Position element at the assigned lane
    const laneY = dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
    element.style.top = `${laneY}px`;
    element.style.visibility = 'visible';

    // Calculate animation duration and padding
    const exitPadding = Math.max(fontSize * LAYOUT.EXIT_PADDING_SCALE, LAYOUT.EXIT_PADDING_MIN);
    const distance = dimensions.width + textWidth + exitPadding;

    // Optimized duration for better pacing
    const duration = Math.max(
      LAYOUT.DURATION_MIN,
      Math.min(LAYOUT.DURATION_MAX, (distance / this.settings.speedPxPerSec) * 1000)
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

    // Update lane state with message dimensions
    const now = Date.now();
    lane.lastItemStartTime = now + laneDelay;
    lane.lastItemExitTime = now + totalDuration;
    lane.lastItemWidthPx = textWidth;
    lane.lastItemHeightPx = messageHeight;

    // Setup cleanup timeout
    const timeoutId = window.setTimeout(() => {
      this.removeMessageByElement(element);
    }, totalDuration + LAYOUT.CLEANUP_BUFFER);

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
      startTime: now,
      duration,
      timeoutId,
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
      // Soft cap warning (non-blocking)
      if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
        this.logPerformanceWarning();
      }

      const message = this.messageQueue.shift();
      if (message) {
        this.renderMessage(message);
        this.processedInLastSecond++;
      }
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
    const isMembership = message.kind === 'membership';

    if (isSuperChat && message.superChat) {
      // Apply card styling
      this.applySuperChatStyling(element, message.superChat);

      // Create structured header and content
      const headerElement = this.createSuperChatHeader(message, message.superChat);
      const contentElement = this.createSuperChatContent(message, message.superChat);

      // Apply dynamic colors if available
      const headerColor = element.getAttribute('data-header-color');
      const contentColor = element.getAttribute('data-content-color');
      if (headerColor && contentColor) {
        // Apply single continuous gradient to entire card
        const seamlessGradient = `linear-gradient(
          to bottom,
          ${this.createRgbaWithAlpha(contentColor, 0.75)},
          ${this.createRgbaWithAlpha(contentColor, 0.5)},
          ${this.createRgbaWithAlpha(contentColor, 0.35)},
          ${this.createRgbaWithAlpha(contentColor, 0.25)}
        )`;
        element.style.background = seamlessGradient;
      }

      element.appendChild(headerElement);
      element.appendChild(contentElement);
    } else if (isMembership) {
      // Membership message
      const membershipCard = this.createMembershipCard(message);
      element.appendChild(membershipCard);
    } else {
      // Regular message (existing logic)
      if (showAuthor) {
        const authorElement = this.createAuthorElement(message);
        element.appendChild(authorElement);
      }

      const contentDiv = document.createElement('div');
      contentDiv.className = 'yt-chat-overlay-message-content';

      if (message.content && message.content.length > 0) {
        this.renderMixedContent(contentDiv, message.content);
      } else {
        contentDiv.textContent = message.text; // SECURITY: textContent only, no innerHTML
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
    const lane = this.findAvailableLane(messageHeight);
    if (lane === null) {
      // No available lane, drop message
      const dimensions = this.overlay.getDimensions();
      console.log(
        `[YT Chat Overlay] No available lane for message (height: ${messageHeight}px). ` +
          `Active messages: ${this.activeMessages.size}, Lanes: ${dimensions?.laneCount || 'unknown'}, ` +
          `Queue size: ${this.messageQueue.length}`
      );
      container.removeChild(element);
      return;
    }

    // Setup animation and positioning
    const activeMessage = this.setupMessageAnimation(
      element,
      lane,
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
      lane: lane.index,
      width: textWidth,
      height: messageHeight,
      dimensions,
    });
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
        const baseSafeDistance = this.settings.fontSize * LAYOUT.SAFE_DISTANCE_SCALE;
        const minSafeDistance = Math.max(baseSafeDistance, LAYOUT.SAFE_DISTANCE_MIN);
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

        if (timeSinceLastStart < LAYOUT.VERTICAL_CLEAR_TIME) {
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
