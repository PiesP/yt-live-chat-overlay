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

    // Render content (text + emojis)
    if (message.content && message.content.length > 0) {
      this.renderMixedContent(element, message.content);
    } else {
      // Fallback: plain text only
      element.textContent = message.text; // SECURITY: textContent only, no innerHTML
    }

    element.style.fontSize = `${this.settings.fontSize}px`;
    element.style.opacity = `${this.settings.opacity}`;

    // Apply color based on author type
    const authorType = message.authorType || 'normal';
    element.style.color = this.settings.colors[authorType];

    // Find available lane
    const lane = this.findAvailableLane();
    if (lane === null) {
      // No available lane, drop message
      console.log('[YT Chat Overlay] No available lane, dropping message');
      return;
    }

    // Position element (start from right edge, off-screen)
    const laneY = dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
    element.style.top = `${laneY}px`;
    element.style.left = `${dimensions.width}px`;

    // Add to container (temporarily to measure width)
    container.appendChild(element);

    // Calculate animation duration
    const textWidth = element.offsetWidth;
    const exitPadding = Math.max(this.settings.fontSize * 2, 80);
    const distance = dimensions.width + textWidth + exitPadding;
    const duration = Math.max(
      4000,
      Math.min(14000, (distance / this.settings.speedPxPerSec) * 1000)
    );
    const laneDelay = (lane.index % 3) * 80;
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
      color: this.settings.colors[authorType],
      lane: lane.index,
      width: textWidth,
      distance,
      duration,
      delay: laneDelay,
      totalDuration,
      dimensions,
    });

    // Update lane state
    const now = Date.now();
    lane.lastItemStartTime = now + laneDelay;
    lane.lastItemExitTime = now + totalDuration;
    lane.lastItemWidthPx = textWidth;

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
   */
  private findAvailableLane(): LaneState | null {
    const now = Date.now();
    const dimensions = this.overlay.getDimensions();
    if (!dimensions) return null;

    for (const lane of this.lanes) {
      if (lane.lastItemStartTime === 0) {
        return lane;
      }

      const minSafeDistance = Math.max(this.settings.fontSize * 1.2, 60);
      const requiredGapPx = Math.max(lane.lastItemWidthPx, minSafeDistance) + minSafeDistance;
      const safeTimeGap = (requiredGapPx / this.settings.speedPxPerSec) * 1000;

      // Check if enough time has passed since last message started
      const timeSinceLastStart = now - lane.lastItemStartTime;

      if (timeSinceLastStart >= safeTimeGap) {
        return lane;
      }
    }

    return null; // No available lane
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
    if (this.isPaused) {
      return; // Already paused
    }

    console.log('[Renderer] Pausing all animations');
    this.isPaused = true;

    for (const active of this.activeMessages) {
      try {
        active.animation.pause();
      } catch (error) {
        console.warn('[Renderer] Failed to pause animation:', error);
      }
    }

    console.log(`[Renderer] Paused ${this.activeMessages.size} animations`);
  }

  /**
   * Resume all active animations and process queued messages
   */
  resume(): void {
    if (!this.isPaused) {
      return; // Not paused
    }

    console.log('[Renderer] Resuming all animations');
    this.isPaused = false;

    for (const active of this.activeMessages) {
      try {
        active.animation.play();
      } catch (error) {
        console.warn('[Renderer] Failed to resume animation:', error);
      }
    }

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

    for (const active of this.activeMessages) {
      try {
        active.animation.playbackRate = rate;
      } catch (error) {
        console.warn('[Renderer] Failed to set playback rate:', error);
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
