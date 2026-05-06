import type {
  ChatMessage,
  ContentSegment,
  EmojiInfo,
  ImageAsset,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import {
  colors,
  RENDERER_LAYOUT as LAYOUT,
  parseRgbColor,
  type RgbColor,
} from '@core/design-tokens';
import { normalizeYouTubeImageUrl } from '@core/youtubei-chat';

interface AuthorNameOptions {
  className?: string;
  color?: string;
  tagName?: 'span' | 'div';
}

interface ImageElementOptions {
  width?: number;
  height?: number;
  candidateUrl?: string;
  fallbackText?: string;
}

export interface BuiltMessage {
  element: HTMLDivElement;
  isSuperChat: boolean;
  isMembership: boolean;
}

const normalizeImageCandidateUrls = (primaryUrl: string, candidateUrl?: string): string[] => {
  const normalizedUrls: string[] = [];
  const seenUrls = new Set<string>();

  const primary = normalizeYouTubeImageUrl(primaryUrl);
  if (primary && !seenUrls.has(primary)) {
    seenUrls.add(primary);
    normalizedUrls.push(primary);
  }

  if (candidateUrl) {
    const fallback = normalizeYouTubeImageUrl(candidateUrl);
    if (fallback && !seenUrls.has(fallback)) {
      seenUrls.add(fallback);
      normalizedUrls.push(fallback);
    }
  }

  return normalizedUrls;
};

export class RendererMessageBuilder {
  constructor(private readonly getSettings: () => Readonly<OverlaySettings>) {}

  buildMessageElement(message: ChatMessage): BuiltMessage | null {
    if (message.kind === 'superchat' && message.superChat) {
      return this.buildSuperChatElement(message, message.superChat);
    }

    if (message.kind === 'membership') {
      return this.buildMembershipElement(message);
    }

    return this.buildRegularMessageElement(message);
  }

  private createImageElement(
    url: string,
    alt: string,
    className: string,
    sizePx: number,
    options: ImageElementOptions = {}
  ): HTMLImageElement | null {
    const candidateUrls = normalizeImageCandidateUrls(url, options.candidateUrl);
    if (candidateUrls.length === 0) {
      return null;
    }

    const img = document.createElement('img');
    let candidateIndex = 0;
    img.src = candidateUrls[candidateIndex] ?? '';
    img.alt = alt;
    img.className = className;
    img.style.height = `${sizePx}px`;
    if (options.width !== undefined && options.height !== undefined && options.height > 0) {
      const displayWidthPx = Math.max(1, (sizePx * options.width) / options.height);
      img.style.width = `${displayWidthPx}px`;
      img.style.aspectRatio = `${options.width} / ${options.height}`;
    } else {
      img.style.width = 'auto';
    }
    img.draggable = false;
    img.decoding = 'async';

    img.addEventListener(
      'error',
      () => {
        const nextCandidateUrl = candidateUrls[candidateIndex + 1];
        if (nextCandidateUrl) {
          candidateIndex += 1;
          img.src = nextCandidateUrl;
          return;
        }

        const fallbackText = options.fallbackText?.trim();
        if (fallbackText && img.parentNode) {
          img.replaceWith(document.createTextNode(fallbackText));
        } else {
          img.remove();
        }
      },
      { once: true }
    );

    return img;
  }

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
    const settings = this.getSettings();
    element.className = className;
    element.textContent = message.author;
    element.style.color = options.color ?? settings.colors[message.authorType];
    return element;
  }

  private createMessageTextElement(
    message: ChatMessage,
    className = 'yt-chat-overlay-message-content',
    color?: string
  ): HTMLDivElement | null {
    const hasRichContent = message.content.length > 0;
    const hasPlainText = message.text.trim().length > 0;

    if (!hasRichContent && !hasPlainText) {
      return null;
    }

    const contentDiv = this.createContainer(className);
    if (color) {
      contentDiv.style.color = color;
    }

    if (hasRichContent) {
      this.renderMixedContent(contentDiv, message.content);
    }

    if (!contentDiv.hasChildNodes() && hasPlainText) {
      contentDiv.textContent = message.text;
    }

    return contentDiv;
  }

  private resolveSuperChatRgb(superChat: SuperChatInfo): RgbColor {
    const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
    const parsed = sourceColor ? parseRgbColor(sourceColor) : null;

    return parsed ?? colors.superChat[superChat.tier];
  }

  private createEmojiElement(emoji: EmojiInfo): HTMLImageElement | null {
    const emojiSize = this.getSettings().fontSize * LAYOUT.EMOJI_SIZE;
    const options: ImageElementOptions = {
      fallbackText: emoji.fallbackText || '[emoji]',
    };
    if (emoji.candidateUrl) {
      options.candidateUrl = emoji.candidateUrl;
    }
    if (emoji.width !== undefined) {
      options.width = emoji.width;
    }
    if (emoji.height !== undefined) {
      options.height = emoji.height;
    }

    return this.createImageElement(
      emoji.url,
      emoji.alt || '',
      'yt-chat-overlay-emoji',
      emojiSize,
      options
    );
  }

  private createSuperChatSticker(sticker: ImageAsset): HTMLImageElement | null {
    const stickerSize = this.getSettings().fontSize * LAYOUT.SUPERCHAT_STICKER_SIZE;
    const options: ImageElementOptions = {};
    if (sticker.candidateUrl) {
      options.candidateUrl = sticker.candidateUrl;
    }
    if (sticker.width !== undefined) {
      options.width = sticker.width;
    }
    if (sticker.height !== undefined) {
      options.height = sticker.height;
    }

    return this.createImageElement(
      sticker.url,
      sticker.alt || 'Super Chat Sticker',
      'yt-chat-overlay-superchat-sticker',
      stickerSize,
      options
    );
  }

  private renderMixedContent(container: HTMLDivElement, segments: ContentSegment[]): void {
    for (const segment of segments) {
      if (segment.type === 'text') {
        container.appendChild(document.createTextNode(segment.content));
        continue;
      }

      const img = this.createEmojiElement(segment.emoji);
      if (img) {
        container.appendChild(img);
      } else if (segment.emoji.alt.length > 0) {
        container.appendChild(document.createTextNode(segment.emoji.alt));
      }
    }
  }

  private shouldShowAuthor(message: ChatMessage): boolean {
    return this.getSettings().showAuthor[message.authorType];
  }

  private createAuthorElement(message: ChatMessage): HTMLDivElement {
    const authorInfoDiv = this.createContainer('yt-chat-overlay-author-info');

    const photoImg = this.createAuthorPhoto(message);
    if (photoImg) {
      authorInfoDiv.appendChild(photoImg);
    }

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

    header.appendChild(this.createSuperChatAmountBadge(superChat.amount));

    if (!showAuthor) {
      header.style.justifyContent = 'flex-end';
    }

    return header;
  }

  private createSuperChatContent(
    message: ChatMessage,
    superChat: SuperChatInfo
  ): HTMLDivElement | null {
    const hasSticker = Boolean(superChat.sticker);
    const messageDiv = this.createMessageTextElement(message);

    if (!messageDiv && !hasSticker) {
      return null;
    }

    const content = this.createContainer('yt-chat-overlay-superchat-body');

    if (superChat.sticker) {
      const stickerImg = this.createSuperChatSticker(superChat.sticker);
      if (stickerImg) {
        content.appendChild(stickerImg);
      }
    }

    if (messageDiv) {
      content.appendChild(messageDiv);
    }

    return content;
  }

  private createMembershipCard(message: ChatMessage): HTMLDivElement {
    const card = this.createContainer('yt-chat-overlay-membership-card');
    const authorSection = this.createContainer('yt-chat-overlay-membership-author');

    const photo = this.createAuthorPhoto(message, 'Member');
    if (photo) {
      authorSection.appendChild(photo);
    }

    const textContainer = this.createContainer('yt-chat-overlay-membership-text');

    const authorName = this.createAuthorNameElement(message, {
      className: 'yt-chat-overlay-membership-author-name',
      color: colors.authorMember,
      tagName: 'div',
    });
    if (authorName) {
      textContainer.appendChild(authorName);
    }

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
    const settings = this.getSettings();
    const color = settings.colors[message.authorType];

    if (showAuthor) {
      element.classList.add('yt-chat-overlay-message-with-author');
      element.appendChild(this.createAuthorElement(message));
    }

    const contentDiv = this.createMessageTextElement(
      message,
      'yt-chat-overlay-message-content',
      color
    );
    if (!contentDiv) {
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
      this.getSettings().showAuthor.superChat
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
}
