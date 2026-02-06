/**
 * Renderer
 *
 * Renders chat messages with Nico-nico style flowing animation.
 * Manages lanes and collision detection.
 */

import type { ChatMessage, LaneState, OutlineSettings, OverlaySettings } from '@app-types';
import type { Overlay } from './overlay';

interface ActiveMessage {
  element: HTMLDivElement;
  lane: number;
  startTime: number;
  duration: number;
  timeoutId: number;
}

export class Renderer {
  private overlay: Overlay;
  private settings: OverlaySettings;
  private lanes: LaneState[] = [];
  private activeMessages: Set<ActiveMessage> = new Set();
  private messageQueue: ChatMessage[] = [];
  private lastProcessTime = 0;
  private processedInLastSecond = 0;
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
    this.processQueue();
  }

  /**
   * Process message queue
   */
  private processQueue(): void {
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
    element.textContent = message.text; // SECURITY: textContent only, no innerHTML
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
    const distance = dimensions.width + textWidth + 100; // padding
    const duration = Math.max(
      4000,
      Math.min(14000, (distance / this.settings.speedPxPerSec) * 1000)
    );

    // Use Web Animations API for dynamic animation
    // Start from current position (right edge) and move to left edge (off-screen)
    const animation = element.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
      {
        duration,
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
      dimensions,
    });

    // Update lane state
    const now = Date.now();
    lane.lastItemStartTime = now;
    lane.lastItemExitTime = now + duration;

    // Setup cleanup timeout (duration + buffer)
    const timeoutId = window.setTimeout(() => {
      this.removeMessageByElement(element);
    }, duration + 2000);

    // Track active message
    const activeMessage: ActiveMessage = {
      element,
      lane: lane.index,
      startTime: now,
      duration,
      timeoutId,
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

    // Calculate minimum safe gap to prevent overlap
    // A message needs to move enough distance before next message can start
    // to ensure they don't collide
    const minSafeDistance = 200; // minimum 200px gap between messages
    const safeTimeGap = (minSafeDistance / this.settings.speedPxPerSec) * 1000;

    for (const lane of this.lanes) {
      // Check if enough time has passed since last message started
      const timeSinceLastStart = now - lane.lastItemStartTime;

      // Also check if the last message has exited enough
      // This ensures previous message moved far enough into the screen
      if (
        timeSinceLastStart >= safeTimeGap &&
        (lane.lastItemExitTime === 0 || now < lane.lastItemExitTime)
      ) {
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
    this.clear();
    if (this.styleElement?.parentNode) {
      this.styleElement.parentNode.removeChild(this.styleElement);
    }
    this.styleElement = null;
  }
}
