/**
 * RendererCSS — CSS DOM-animation based renderer.
 *
 * Extends RendererBase for shared state machine, rate limiting, burst
 * detection, and lane allocation.  Owns CSS-specific rendering: DOM element
 * creation, @keyframes animation setup, and style injection.
 *
 * All magic numbers come from rendererLayout in design-tokens.ts.
 */

import type {
  ChatMessage,
  DanmakuMode,
  OverlayDimensions,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import type { RgbColor } from '@core/design-tokens';
import {
  borderRadius,
  buildTextShadow,
  buildTextStroke,
  computeDliosDuration,
  colors as designColors,
  parseRgbColor,
  rendererLayout,
  shadows,
  spacing,
  typography,
} from '@core/design-tokens';
import type { LanePlacement } from '@core/lane-allocator';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { RendererBase, type RendererUpdateOptions } from '@core/renderer-base';
import { estimateMessageDimensions } from '@core/renderer-shared';
import { normalizeYouTubeImageUrl } from '@core/youtubei-chat';

const log = createLogger('RendererCSS');

// ── Internal types ──────────────────────────────────────────────────────────

interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
  priority: number;
  retries: number;
}

interface ActiveMessage {
  element: HTMLDivElement;
  readonly startTime: number;
  readonly baseDuration: number;
  readonly baseOpacity: number;
  readonly cleanup: () => void;
  pausedDuration: number;
}

type RenderResult =
  | { status: 'rendered' }
  | { status: 'dropped' }
  | { status: 'deferred'; waitMs: number };

interface RenderContext {
  container: HTMLDivElement;
  dimensions: OverlayDimensions;
}

// ── Static CSS styles ────────────────────────────────────────────────────────

const STATIC_STYLES = `
  .yt-chat-overlay-message {
    position: absolute;
    white-space: nowrap;
    font-family: system-ui, -apple-system, sans-serif;
    font-weight: var(--yt-overlay-font-weight, 700);
    line-height: 1.1;
    text-shadow: var(--yt-overlay-message-text-shadow, none);
    -webkit-text-stroke: var(--yt-overlay-text-stroke, 0 transparent);
    color: ${designColors.ui.text};
    pointer-events: none;
    will-change: transform;
    backface-visibility: hidden;
    perspective: 1000;
    transform: translateZ(0);
    contain: paint layout style;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .yt-chat-overlay-message-with-author {
    display: flex;
    flex-direction: column;
    gap: ${spacing.xs}px;
  }
  .yt-chat-overlay-author-info {
    display: flex;
    align-items: center;
    gap: ${spacing.sm}px;
    font-size: ${rendererLayout.authorFontScale}em;
    opacity: 0.95;
  }
  .yt-chat-overlay-author-photo {
    width: ${rendererLayout.authorPhotoSize}px;
    height: ${rendererLayout.authorPhotoSize}px;
    border-radius: ${borderRadius.full};
    flex-shrink: 0;
    box-shadow: ${shadows.box.sm};
    filter: ${shadows.filter.md};
  }
  .yt-chat-overlay-author-name {
    font-weight: ${typography.fontWeight.semibold};
  }
  .yt-chat-overlay-message-content {
    display: block;
    color: inherit;
  }
  .yt-chat-overlay-superchat-card {
    --yt-sc-rgb: 30, 136, 229;
    --yt-sc-border-rgb: 18, 92, 156;
    --yt-sc-accent: rgb(var(--yt-sc-rgb));
    display: flex;
    flex-direction: column;
    min-width: min(280px, 60vw);
    max-width: min(640px, 86vw);
    border-radius: ${borderRadius.md};
    overflow: hidden;
    border: 1px solid rgba(var(--yt-sc-border-rgb), 0.55);
    border-left: 4px solid var(--yt-sc-accent);
    background-color: rgb(30, 136, 229);
    background: linear-gradient(180deg,
      rgba(var(--yt-sc-rgb), var(--yt-overlay-superchat-top-opacity, 0.46)) 0%,
      rgba(var(--yt-sc-rgb), var(--yt-overlay-superchat-base-opacity, 0.4)) 48%,
      rgba(var(--yt-sc-rgb), var(--yt-overlay-superchat-bottom-opacity, 0.4)) 100%);
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
    color: ${designColors.ui.text};
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
  .yt-chat-overlay-message-with-author:not(.yt-chat-overlay-superchat-card) {
    padding: ${spacing.sm}px ${spacing.md}px;
    border-radius: ${borderRadius.sm};
  }
  .yt-chat-overlay-message-with-author .yt-chat-overlay-author-photo {
    box-shadow: ${shadows.box.sm};
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .yt-chat-overlay-message:not(.yt-chat-overlay-superchat-card) {
    text-shadow: var(--yt-overlay-regular-message-text-shadow, ${shadows.text.lg});
    letter-spacing: 0.3px;
  }
  .yt-chat-overlay-superchat-sticker {
    display: inline-block;
    vertical-align: middle;
    margin-right: ${spacing.sm}px;
    filter: ${shadows.filter.md};
  }
  .yt-chat-overlay-emoji {
    display: inline-block;
    vertical-align: text-bottom;
    margin: 0 2px;
    pointer-events: none;
    filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
  }
  .yt-chat-overlay-membership-card {
    display: flex;
    flex-direction: column;
    padding: ${spacing.md}px ${spacing.lg}px;
    border-radius: ${borderRadius.md};
    background: rgba(15, 157, 88, 0.28);
    border: 2px solid rgba(15, 157, 88, 0.6);
    box-shadow: ${shadows.box.md};
    backdrop-filter: blur(4px);
    animation: yt-overlay-membership-glow 2s ease-in-out infinite;
  }
  @keyframes yt-overlay-membership-glow {
    0%, 100% { border-color: rgba(15, 157, 88, 0.6); }
    50% { border-color: rgba(15, 157, 88, 0.9); }
  }
  .yt-chat-overlay-membership-author {
    display: flex;
    align-items: center;
    gap: ${spacing.md}px;
  }
  .yt-chat-overlay-membership-text {
    display: flex;
    flex-direction: column;
    gap: ${spacing.xs}px;
  }
  .yt-chat-overlay-membership-author-name {
    font-size: ${typography.fontSize.base};
    font-weight: ${typography.fontWeight.bold};
    text-shadow: ${shadows.text.md};
  }
  .yt-chat-overlay-membership-message {
    font-size: ${typography.fontSize.sm};
    font-weight: ${typography.fontWeight.normal};
    color: ${designColors.ui.text};
    text-shadow: ${shadows.text.sm};
  }
  @keyframes yt-overlay-comment-slide {
    from { transform: translateX(var(--yt-msg-entry-offset, 0px)); }
    to { transform: translateX(var(--yt-msg-exit-offset, -3000px)); }
  }
  @keyframes yt-overlay-comment-slide-reverse {
    from { transform: translateX(calc(-100vw - var(--yt-msg-entry-offset, 0px))); }
    to { transform: translateX(calc(100vw + 100px)); }
  }
  @keyframes yt-overlay-comment-fixed-top {
    from { transform: translateY(-100%); opacity: 0; }
    10% { opacity: 1; }
    80% { opacity: 1; }
    to { opacity: 0; }
  }
  @keyframes yt-overlay-comment-fixed-bottom {
    from { transform: translateY(100%); opacity: 0; }
    10% { opacity: 1; }
    80% { opacity: 1; }
    to { opacity: 0; }
  }
  .yt-overlay-message-animate {
    animation-name: yt-overlay-comment-slide;
    animation-duration: var(--yt-msg-duration, 8s);
    animation-delay: var(--yt-msg-delay, 0ms);
    animation-timing-function: linear;
    animation-fill-mode: both;
  }
  .yt-overlay-message-animate-reverse {
    animation-name: yt-overlay-comment-slide-reverse;
    animation-duration: var(--yt-msg-duration, 8s);
    animation-delay: var(--yt-msg-delay, 0ms);
    animation-timing-function: linear;
    animation-fill-mode: both;
  }
  .yt-overlay-message-animate-top {
    animation-name: yt-overlay-comment-fixed-top;
    animation-duration: var(--yt-msg-duration, 4s);
    animation-delay: var(--yt-msg-delay, 0ms);
    animation-timing-function: ease-out;
    animation-fill-mode: both;
  }
  .yt-overlay-message-animate-bottom {
    animation-name: yt-overlay-comment-fixed-bottom;
    animation-duration: var(--yt-msg-duration, 4s);
    animation-delay: var(--yt-msg-delay, 0ms);
    animation-timing-function: ease-out;
    animation-fill-mode: both;
  }
`;

// ── Image element builder ────────────────────────────────────────────────────

function createImageElement(
  url: string,
  alt: string,
  className: string,
  sizePx: number,
  candidateUrl?: string,
  fallbackText?: string
): HTMLImageElement | null {
  const urls: string[] = [];
  const normalized = normalizeYouTubeImageUrl(url);
  if (normalized) urls.push(normalized);
  if (candidateUrl) {
    const normalizedCandidate = normalizeYouTubeImageUrl(candidateUrl);
    if (normalizedCandidate && !urls.includes(normalizedCandidate)) {
      urls.push(normalizedCandidate);
    }
  }
  if (urls.length === 0) return null;

  const img = document.createElement('img');
  let candidateIndex = 0;
  img.src = urls[candidateIndex] ?? '';
  img.alt = alt;
  img.className = className;
  img.style.height = `${sizePx}px`;
  img.style.width = 'auto';
  img.draggable = false;
  img.decoding = 'async';

  img.addEventListener(
    'error',
    () => {
      const nextUrl = urls[candidateIndex + 1];
      if (nextUrl) {
        candidateIndex += 1;
        img.src = nextUrl;
        return;
      }
      const fallback = fallbackText?.trim();
      if (fallback && img.parentNode) {
        img.replaceWith(document.createTextNode(fallback));
      } else {
        img.remove();
      }
    },
    { once: true }
  );

  return img;
}

// ── DOM element builders ─────────────────────────────────────────────────────

function createContainer(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function resolveSuperChatRgb(superChat: SuperChatInfo): RgbColor {
  const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
  const parsed = sourceColor ? parseRgbColor(sourceColor) : null;
  return parsed ?? designColors.superChat[superChat.tier];
}

function buildSuperChatHeader(
  message: ChatMessage,
  superChat: SuperChatInfo,
  showAuthor: boolean
): HTMLDivElement {
  const header = createContainer('yt-chat-overlay-superchat-meta');

  if (showAuthor) {
    const authorSection = createContainer('yt-chat-overlay-superchat-author');
    if (message.authorPhotoUrl) {
      const photo = createImageElement(
        message.authorPhotoUrl,
        message.author || 'Author',
        'yt-chat-overlay-author-photo',
        rendererLayout.authorPhotoSize
      );
      if (photo) authorSection.appendChild(photo);
    }
    if (message.author) {
      const name = document.createElement('span');
      name.className = 'yt-chat-overlay-author-name';
      name.textContent = message.author;
      authorSection.appendChild(name);
    }
    if (authorSection.childElementCount > 0) {
      header.appendChild(authorSection);
    }
  }

  const amountBadge = document.createElement('span');
  amountBadge.className = 'yt-chat-overlay-superchat-amount';
  amountBadge.textContent = superChat.amount;
  header.appendChild(amountBadge);

  if (!showAuthor) {
    header.style.justifyContent = 'flex-end';
  }

  return header;
}

function buildSuperChatContent(
  message: ChatMessage,
  superChat: SuperChatInfo
): HTMLDivElement | null {
  const hasSticker = !!superChat.sticker;
  const messageDiv = message.text.trim()
    ? createContainer('yt-chat-overlay-message-content')
    : null;
  if (messageDiv) messageDiv.textContent = message.text;

  if (!messageDiv && !hasSticker) return null;

  const content = createContainer('yt-chat-overlay-superchat-body');

  if (superChat.sticker) {
    const stickerImg = createImageElement(
      superChat.sticker.url,
      superChat.sticker.alt || 'Super Chat Sticker',
      'yt-chat-overlay-superchat-sticker',
      Math.round(20 * rendererLayout.superchatStickerSize),
      superChat.sticker.candidateUrl
    );
    if (stickerImg) content.appendChild(stickerImg);
  }

  if (messageDiv) content.appendChild(messageDiv);
  return content;
}

function applySuperChatStyling(element: HTMLDivElement, superChat: SuperChatInfo): void {
  element.classList.add('yt-chat-overlay-superchat-card');
  const rgb = resolveSuperChatRgb(superChat);
  const borderRgb = {
    r: Math.max(0, rgb.r - 36),
    g: Math.max(0, rgb.g - 36),
    b: Math.max(0, rgb.b - 36),
  };
  element.style.setProperty('--yt-sc-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  element.style.setProperty('--yt-sc-border-rgb', `${borderRgb.r}, ${borderRgb.g}, ${borderRgb.b}`);
}

function buildRegularMessageElement(
  message: ChatMessage,
  showAuthor: boolean,
  color: string
): BuiltMessage | null {
  const element = createContainer('yt-chat-overlay-message');
  element.classList.add('yt-chat-overlay-message-with-author');

  if (showAuthor) {
    const authorInfo = createContainer('yt-chat-overlay-author-info');
    if (message.authorPhotoUrl) {
      const photo = createImageElement(
        message.authorPhotoUrl,
        message.author || 'Author',
        'yt-chat-overlay-author-photo',
        rendererLayout.authorPhotoSize
      );
      if (photo) authorInfo.appendChild(photo);
    }
    if (message.author) {
      const name = document.createElement('span');
      name.className = 'yt-chat-overlay-author-name';
      name.textContent = message.author;
      name.style.color = color;
      authorInfo.appendChild(name);
    }
    element.appendChild(authorInfo);
  }

  const contentDiv = createContainer('yt-chat-overlay-message-content');
  contentDiv.style.color = color;
  if (message.text.trim()) {
    contentDiv.textContent = message.text;
  }
  if (!contentDiv.hasChildNodes()) return null;

  element.appendChild(contentDiv);
  return { element, isSuperChat: false, isMembership: false };
}

interface BuiltMessage {
  element: HTMLDivElement;
  isSuperChat: boolean;
  isMembership: boolean;
}

function buildMessageElement(message: ChatMessage, settings: OverlaySettings): BuiltMessage | null {
  const showAuthor = settings.showAuthor[message.authorType];
  const color =
    settings.preserveUserColor && message.userColor
      ? message.userColor
      : settings.colors[message.authorType];

  if (message.kind === 'superchat' && message.superChat) {
    const element = createContainer('yt-chat-overlay-message');
    applySuperChatStyling(element, message.superChat);
    const header = buildSuperChatHeader(message, message.superChat, settings.showAuthor.superChat);
    const content = buildSuperChatContent(message, message.superChat);
    element.appendChild(header);
    if (content) element.appendChild(content);
    return { element, isSuperChat: true, isMembership: false };
  }

  if (message.kind === 'membership') {
    const element = createContainer('yt-chat-overlay-message');
    const card = createContainer('yt-chat-overlay-membership-card');
    const authorSection = createContainer('yt-chat-overlay-membership-author');

    if (message.authorPhotoUrl) {
      const photo = createImageElement(
        message.authorPhotoUrl,
        message.author || 'Member',
        'yt-chat-overlay-author-photo',
        rendererLayout.authorPhotoSize
      );
      if (photo) authorSection.appendChild(photo);
    }

    const textContainer = createContainer('yt-chat-overlay-membership-text');
    if (message.author) {
      const name = document.createElement('div');
      name.className = 'yt-chat-overlay-membership-author-name';
      name.textContent = message.author;
      name.style.color = designColors.authorMember;
      textContainer.appendChild(name);
    }
    if (message.text.trim()) {
      const msg = document.createElement('div');
      msg.className = 'yt-chat-overlay-membership-message';
      msg.textContent = message.text;
      textContainer.appendChild(msg);
    }
    authorSection.appendChild(textContainer);
    card.appendChild(authorSection);
    element.appendChild(card);
    return { element, isSuperChat: false, isMembership: true };
  }

  return buildRegularMessageElement(message, showAuthor, color);
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export class Renderer extends RendererBase {
  private activeMessages: Set<ActiveMessage> = new Set();
  private readonly pendingQueue: QueuedMessage[] = [];
  private danmakuMode: DanmakuMode = 'scroll';
  private lastWarningTime = 0;
  private styleElement: HTMLStyleElement | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private sweepCounter = 0;
  private processQueueScheduled = false;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);
    this.danmakuMode = settings.danmakuMode;
    this.injectStyles();

    this.overlayDimensionsUnsubscribe = this.overlay.onDimensionsChanged((dimensions) => {
      this.handleOverlayDimensionsChange(dimensions);
    });
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;

    const priority = RendererBase.getMessagePriority(message);

    if (this.pendingQueue.length >= rendererLayout.queueMaxSize) {
      const lastIndex = this.pendingQueue.length - 1;
      const removed = this.pendingQueue[lastIndex];
      if (removed && priority > removed.priority) {
        this.pendingQueue.splice(lastIndex, 1);
        this.observability.onMessageDropped('queue_overflow');
      } else {
        this.observability.onMessageDropped('queue_overflow');
        return;
      }
    }

    const queued: QueuedMessage = { message, nextAttemptAt: 0, priority, retries: 0 };
    const insertIndex = this.pendingQueue.findIndex((q) => q.priority < priority);
    if (insertIndex === -1) {
      this.pendingQueue.push(queued);
    } else {
      this.pendingQueue.splice(insertIndex, 0, queued);
    }

    if (!this.isPaused) {
      this.scheduleProcessQueue();
    }
  }

  // ── Queue processing ─────────────────────────────────────────────────

  private scheduleProcessQueue(): void {
    if (this.processQueueScheduled || this.isPaused) return;
    this.processQueueScheduled = true;
    queueMicrotask(() => {
      this.processQueueScheduled = false;
      if (!this.isPaused) {
        this.processQueue();
      }
    });
  }

  private processQueue(): void {
    if (this.isPaused) return;
    if (this.isAntiBlockActive()) return;

    this.sweepStaleAnimations();
    this.clearRetryTimer();

    this.observability.updateQueueDepth(this.pendingQueue.length);
    this.observability.updateActiveMessages(this.activeMessages.size);
    this.observability.updateLaneUtilization(
      this.activeMessages.size / Math.max(1, this.laneAllocator.getLaneCount())
    );

    if (this.pendingQueue.length === 0) return;

    const now = performance.now();
    const nextMessage = this.pendingQueue[0];
    if (!nextMessage) return;

    if (nextMessage.nextAttemptAt > now) {
      this.scheduleRetry(nextMessage.nextAttemptAt - now);
      return;
    }

    if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
      this.logPerformanceWarning();
    }

    let processed = 0;
    let droppedCount = 0;

    while (this.pendingQueue.length > 0 && processed < rendererLayout.batchSize) {
      const queued = this.pendingQueue[0];
      if (!queued) break;

      if (queued.nextAttemptAt > performance.now()) {
        this.scheduleRetry(queued.nextAttemptAt - performance.now());
        break;
      }

      const result = this.renderOneMessage(queued.message);

      if (result.status === 'deferred') {
        queued.nextAttemptAt = performance.now() + result.waitMs;
        this.scheduleRetry(Math.min(result.waitMs, rendererLayout.retryDelayMaxMs));
        this.pendingQueue.shift();
        const insertBefore = this.pendingQueue.findIndex((q) => q.priority < queued.priority);
        if (insertBefore === -1) {
          this.pendingQueue.push(queued);
        } else {
          this.pendingQueue.splice(insertBefore, 0, queued);
        }
        processed++;
        continue;
      }

      if (result.status === 'dropped') {
        this.pendingQueue.shift();
        droppedCount++;
        queued.retries++;
        if (queued.retries < rendererLayout.maxRetries) {
          const insertBefore = this.pendingQueue.findIndex((q) => q.priority < queued.priority);
          if (insertBefore === -1) {
            this.pendingQueue.push(queued);
          } else {
            this.pendingQueue.splice(insertBefore, 0, queued);
          }
        } else {
          this.observability.onMessageDropped('other');
        }
        continue;
      }

      this.pendingQueue.shift();
      processed++;
    }

    if (droppedCount > 0) {
      log.debug(`${droppedCount} message(s) dropped, requeued with retry`);
    }

    const queueRatio = this.pendingQueue.length / rendererLayout.queueMaxSize;
    if (queueRatio > 0.8 && this.backlogPaused === false) {
      this.backlogPaused = true;
      this.onBacklogPauseChange?.(true);
    } else if (queueRatio < 0.4 && this.backlogPaused === true) {
      this.backlogPaused = false;
      this.onBacklogPauseChange?.(false);
    }

    if (this.pendingQueue.length > 0 && !this.isPaused) {
      this.scheduleRetry(rendererLayout.retryDelayMinMs);
    }
  }

  // ── CSS rendering ────────────────────────────────────────────────────

  private getRenderContext(): RenderContext | null {
    const container = this.overlay.getContainer();
    const dimensions = this.overlay.getDimensions();
    if (!container?.isConnected || !dimensions) return null;
    return { container, dimensions };
  }

  private renderOneMessage(message: ChatMessage): RenderResult {
    const renderContext = this.getRenderContext();
    if (!renderContext) {
      return { status: 'dropped' };
    }

    const { container, dimensions } = renderContext;
    const estimated = estimateMessageDimensions(
      message,
      this.settings.fontSize,
      this.settings.showAuthor[message.authorType],
      this.settings.fontWeight
    );
    const messageHeight = estimated.height;

    const placement = this.laneAllocator.findPlacement(messageHeight, dimensions);
    if (placement === null) {
      this.observability.onMessageDropped('no_lane_available');
      return { status: 'dropped' };
    }

    if (placement.waitMs > 0) {
      return { status: 'deferred', waitMs: placement.waitMs };
    }

    const builtMessage = buildMessageElement(message, this.settings);
    if (!builtMessage) {
      return { status: 'dropped' };
    }

    const { element, isSuperChat, isMembership } = builtMessage;
    const baseOpacity = this.settings.opacity;
    const effectiveOpacity = message.isBacklog ? baseOpacity * 0.5 : baseOpacity;
    this.applyCommonMessageStyles(element, message, isSuperChat, isMembership, effectiveOpacity);

    const activeMessage = this.setupMessageAnimation(
      element,
      placement,
      estimated.width,
      messageHeight,
      dimensions,
      message,
      effectiveOpacity
    );

    container.appendChild(element);
    this.activeMessages.add(activeMessage);
    this.observability.onMessageRendered();

    return { status: 'rendered' };
  }

  private setupMessageAnimation(
    element: HTMLDivElement,
    placement: LanePlacement,
    textWidth: number,
    messageHeight: number,
    dimensions: OverlayDimensions,
    message?: ChatMessage,
    baseOpacity?: number
  ): ActiveMessage {
    const fontSize = this.settings.fontSize;
    const { lane, laneY } = placement;
    const mode = this.danmakuMode;
    const effectiveSpeedPxPerSec = this.getEffectiveSpeedPxPerSec();
    const now = performance.now();

    let baseDuration: number;
    let laneDelay = Math.floor(Math.random() * rendererLayout.maxAnimationJitterMs);
    let startTime = now + laneDelay;

    if (mode === 'top' || mode === 'bottom') {
      element.style.left = `${Math.random() * (dimensions.width - Math.min(textWidth, dimensions.width))}px`;
      if (mode === 'top') {
        element.style.top = `${dimensions.height * this.settings.safeTop}px`;
      } else {
        element.style.top = `${dimensions.height * (1 - this.settings.safeBottom) - messageHeight}px`;
      }
      element.style.visibility = 'visible';
      baseDuration = rendererLayout.topBottomDurationMs;
      laneDelay = 0;
      startTime = now;
      this.laneAllocator.commitPlacement(placement, textWidth, startTime);
    } else if (mode === 'reverse') {
      const reverseTotalDistance = dimensions.width * 2 + rendererLayout.exitPaddingMin;
      baseDuration = computeDliosDuration(reverseTotalDistance, effectiveSpeedPxPerSec);
      element.style.top = `${laneY}px`;
      element.style.right = '0';
      element.style.visibility = 'visible';
      startTime = now + laneDelay;
      this.laneAllocator.commitPlacement(placement, textWidth, startTime);
    } else {
      element.style.top = `${laneY}px`;
      element.style.left = `${dimensions.width}px`;
      element.style.visibility = 'visible';

      const exitPadding = Math.max(
        fontSize * rendererLayout.exitPaddingScale,
        rendererLayout.exitPaddingMin
      );
      const exitDistance = dimensions.width + textWidth + exitPadding;

      const baseOffset =
        dimensions.laneCount > 1
          ? Math.round(
              (lane.index / (dimensions.laneCount - 1)) * rendererLayout.entryOffsetRangeMs
            )
          : 100;
      const jitter = Math.floor(Math.random() * rendererLayout.laneJitterMs);
      const entryOffset = baseOffset + jitter;

      const totalDistance = entryOffset + dimensions.width + textWidth + exitPadding;
      baseDuration = computeDliosDuration(totalDistance, effectiveSpeedPxPerSec);

      element.style.setProperty('--yt-msg-entry-offset', `${entryOffset}px`);
      element.style.setProperty('--yt-msg-exit-offset', `-${exitDistance}px`);
      startTime = now + laneDelay;
      this.laneAllocator.commitPlacement(placement, textWidth, startTime);
    }

    if (message?.isBacklog && this.backlogSpeedMultiplier > 1) {
      baseDuration = Math.max(
        rendererLayout.durationMin,
        baseDuration / this.backlogSpeedMultiplier
      );
    }
    const adjustedDuration = baseDuration / this.playbackRate;

    element.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
    element.style.setProperty('--yt-msg-delay', `${laneDelay}ms`);

    if (mode === 'reverse') {
      element.classList.add('yt-overlay-message-animate-reverse');
    } else if (mode === 'top') {
      element.classList.add('yt-overlay-message-animate-top');
    } else if (mode === 'bottom') {
      element.classList.add('yt-overlay-message-animate-bottom');
    } else {
      element.classList.add('yt-overlay-message-animate');
    }

    const cleanup = (): void => {
      element.removeEventListener('animationend', cleanup);
      this.removeMessageByElement(element);
    };
    element.addEventListener('animationend', cleanup, { once: true });

    return {
      element,
      startTime,
      baseDuration,
      baseOpacity: baseOpacity ?? this.settings.opacity,
      cleanup,
      pausedDuration: 0,
    };
  }

  // ── Style injection ──────────────────────────────────────────────────

  private injectStyles(): void {
    if (!this.styleElement) {
      this.styleElement = document.createElement('style');
      this.styleElement.textContent = STATIC_STYLES;
      document.head.appendChild(this.styleElement);
    }
    this.updateStyleVariables();
  }

  private updateStyleVariables(): void {
    const container = this.overlay.getContainer();
    if (!container) return;

    const textShadow = buildTextShadow(this.settings.outline);
    const textStroke = buildTextStroke(this.settings.outline);
    const regularMessageTextShadow = [
      textShadow,
      shadows.text.md,
      '0 0 8px rgba(0, 0, 0, 0.7)',
    ].join(', ');
    const superChatBaseOpacity = Math.min(1, Math.max(0.4, this.settings.superChatOpacity));
    const superChatTopOpacity = Math.min(1, superChatBaseOpacity + 0.06);
    const superChatBottomOpacity = Math.max(0.4, superChatBaseOpacity - 0.08);

    container.style.setProperty(
      '--yt-overlay-font-weight',
      this.settings.fontWeight === 'bold' ? '700' : '400'
    );

    container.style.setProperty('--yt-overlay-message-text-shadow', textShadow);
    container.style.setProperty(
      '--yt-overlay-regular-message-text-shadow',
      regularMessageTextShadow
    );
    container.style.setProperty('--yt-overlay-text-stroke', textStroke);
    container.style.setProperty('--yt-overlay-superchat-base-opacity', `${superChatBaseOpacity}`);
    container.style.setProperty('--yt-overlay-superchat-top-opacity', `${superChatTopOpacity}`);
    container.style.setProperty(
      '--yt-overlay-superchat-bottom-opacity',
      `${superChatBottomOpacity}`
    );
  }

  // ── Retry scheduling ─────────────────────────────────────────────────

  private scheduleRetry(waitMs: number): void {
    if (this.isPaused) return;
    const delay = Math.max(
      rendererLayout.retryDelayMinMs,
      Math.min(waitMs, rendererLayout.retryDelayMaxMs)
    );
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.processQueue();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // ── Sweep stale animations ───────────────────────────────────────────

  private sweepStaleAnimations(): void {
    if (this.activeMessages.size === 0) return;
    this.sweepCounter++;
    if (this.sweepCounter % rendererLayout.sweepInterval !== 0) return;

    const toRemove: ActiveMessage[] = [];
    const now = performance.now();
    for (const active of this.activeMessages) {
      try {
        const elapsed = now - active.startTime - active.pausedDuration;
        if (elapsed >= active.baseDuration + rendererLayout.sweepToleranceMs) {
          toRemove.push(active);
        }
      } catch {
        toRemove.push(active);
      }
    }

    for (const active of toRemove) {
      this.activeMessages.delete(active);
      if (active.element.parentNode) {
        active.element.remove();
      }
    }
  }

  // ── Message lifecycle ────────────────────────────────────────────────

  private removeMessageByElement(element: HTMLDivElement): void {
    for (const active of this.activeMessages) {
      if (active.element === element) {
        this.removeMessage(active);
        return;
      }
    }
  }

  private removeMessage(active: ActiveMessage): void {
    this.activeMessages.delete(active);
    try {
      active.element.removeEventListener('animationend', active.cleanup);
    } catch {
      // Element may already be detached.
    }
    if (active.element.parentNode) {
      active.element.remove();
    }
  }

  private applyCommonMessageStyles(
    element: HTMLDivElement,
    message: ChatMessage,
    isSuperChat: boolean,
    isMembership: boolean,
    effectiveOpacity: number
  ): void {
    element.style.fontSize = `${this.settings.fontSize}px`;
    element.style.opacity = `${effectiveOpacity}`;
    if (!isSuperChat && !isMembership) {
      element.style.color = this.settings.colors[message.authorType];
    }
  }

  private logPerformanceWarning(): void {
    const now = performance.now();
    if (now - this.lastWarningTime < 10_000) return;
    this.lastWarningTime = now;
    log.warn(
      `Performance warning: ${this.activeMessages.size} concurrent messages ` +
        `(recommended max: ${this.settings.maxConcurrentMessages}).`
    );
  }

  // ── Queue trimming ───────────────────────────────────────────────────

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length <= rendererLayout.backgroundQueueMax) return;
    this.pendingQueue.sort(
      (a, b) => b.priority - a.priority || a.message.timestamp - b.message.timestamp
    );
    this.pendingQueue.length = rendererLayout.backgroundQueueMax;
  }

  // ── Dimension change handler ─────────────────────────────────────────

  private handleOverlayDimensionsChange(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.resetState();
      this.laneAllocator.reset(null);
      return;
    }
    this.laneAllocator.reset(dimensions);
    if (!this.isPaused && !this.isVideoPaused && this.pendingQueue.length > 0) {
      this.processQueue();
    }
  }

  // ── Settings update ──────────────────────────────────────────────────

  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    super.updateSettings(settings, options);
    this.danmakuMode = settings.danmakuMode;
    this.injectStyles();
  }

  // ── Abstract hook implementations ────────────────────────────────────

  protected onPause(): void {
    this.clearRetryTimer();
    for (const active of this.activeMessages) {
      active.element.style.animationPlayState = 'paused';
    }
  }

  protected onResume(): void {
    for (const active of [...this.activeMessages]) {
      try {
        const elapsed = performance.now() - active.startTime - active.pausedDuration;
        const remaining = active.baseDuration - elapsed;
        if (remaining <= 0) {
          this.removeMessage(active);
          continue;
        }
        const el = active.element;
        el.style.setProperty('--yt-msg-delay', `${-elapsed}ms`);
        Renderer.triggerAnimationRestart(el);
        el.style.animationPlayState = 'running';
      } catch {
        active.element.style.animationPlayState = 'running';
      }
    }
    this.processQueue();
  }

  onPlaybackRateChange(rate: number): void {
    for (const active of this.activeMessages) {
      try {
        const elapsed = performance.now() - active.startTime - active.pausedDuration;
        const adjustedDuration = active.baseDuration / rate;
        const el = active.element;
        el.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
        el.style.setProperty('--yt-msg-delay', `${-Math.min(elapsed, active.baseDuration)}ms`);
        Renderer.triggerAnimationRestart(el);
      } catch {
        // Best-effort update.
      }
    }
  }

  protected applyPausedDuration(pausedMs: number): void {
    for (const active of [...this.activeMessages]) {
      active.pausedDuration += pausedMs;
    }
  }

  protected resetState(): void {
    this.clearRetryTimer();
    for (const active of [...this.activeMessages]) {
      this.removeMessage(active);
    }
    this.pendingQueue.length = 0;
    this.backlogPaused = false;
  }

  protected onDestroy(): void {
    this.overlayDimensionsUnsubscribe?.();
    this.overlayDimensionsUnsubscribe = null;
    this.resetState();
    this.pausedAt = null;
    this.playbackRate = 1;
    this.styleElement?.remove();
    this.styleElement = null;
  }

  private static triggerAnimationRestart(element: HTMLElement): void {
    element.style.animation = 'none';
    void element.offsetWidth;
    element.style.animation = '';
  }
}
