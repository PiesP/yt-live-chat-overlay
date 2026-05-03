import type {
  AuthorType,
  ChatMessage,
  ContentSegment,
  EmojiInfo,
  ImageAsset,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import { parseRgbColor } from '@core/design-tokens';
import { normalizeYouTubeImageUrl } from '@core/image-url';
import { createLogger } from '@core/logging';
import { asRecord, getNumber, getString, isRecord, type JsonObject } from '@core/youtubei-chat';

const log = createLogger('ChatMessageParser');

const EMOJI_TEXT_PATTERN = /\p{Extended_Pictographic}/u;
const EMOJI_ALIAS_PATTERN = /^:[^:\s][^:]*:$/u;
const AUTHOR_TYPE_PRIORITY = {
  normal: 0,
  verified: 1,
  member: 2,
  moderator: 3,
  owner: 4,
} as const satisfies Record<AuthorType, number>;

type ChatMessageKind = ChatMessage['kind'];

interface ParsedMessageBody {
  text: string;
  content: ContentSegment[];
  visibleLength: number;
}

export interface ChatEvent {
  message: ChatMessage;
  offsetMs?: number;
}

interface SupportedRenderer {
  kind: ChatMessageKind;
  renderer: JsonObject;
}

interface ThumbnailCandidate {
  url: string;
  width?: number;
  height?: number;
}

export class ChatMessageParser {
  constructor(private readonly getSettings: (() => Readonly<OverlaySettings>) | null = null) {}

  extractChatEvents(actions: readonly unknown[]): ChatEvent[] {
    const events: ChatEvent[] = [];

    for (const action of actions) {
      if (!isRecord(action)) {
        continue;
      }

      const replayAction = asRecord(action.replayChatItemAction);
      if (replayAction) {
        const offsetMs = getNumber(replayAction.videoOffsetTimeMsec);
        const nestedActions = Array.isArray(replayAction.actions) ? replayAction.actions : [];
        for (const nestedAction of nestedActions) {
          const event = this.extractChatEventFromAction(nestedAction, offsetMs);
          if (event) {
            events.push(event);
          }
        }
        continue;
      }

      const event = this.extractChatEventFromAction(action, undefined);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private extractChatEventFromAction(action: unknown, offsetMs?: number): ChatEvent | null {
    if (!isRecord(action)) {
      return null;
    }

    const item = this.extractActionItem(action);
    if (!item) {
      return null;
    }

    const supportedRenderer = this.extractSupportedRenderer(item);
    if (!supportedRenderer) {
      return null;
    }

    const message = this.parseRendererMessage(supportedRenderer.renderer, supportedRenderer.kind);
    if (!message) {
      return null;
    }

    return offsetMs === undefined ? { message } : { message, offsetMs };
  }

  private extractActionItem(action: JsonObject): JsonObject | null {
    const addChatItemAction = asRecord(action.addChatItemAction);
    if (addChatItemAction) {
      const item = asRecord(addChatItemAction.item);
      if (item) {
        return item;
      }
    }

    const replaceChatItemAction = asRecord(action.replaceChatItemAction);
    if (replaceChatItemAction) {
      const item = asRecord(replaceChatItemAction.item);
      if (item) {
        return item;
      }
    }

    return null;
  }

  private extractSupportedRenderer(item: JsonObject): SupportedRenderer | null {
    const textRenderer = asRecord(item.liveChatTextMessageRenderer);
    if (textRenderer) {
      return { kind: 'text', renderer: textRenderer };
    }

    const paidMessageRenderer = asRecord(item.liveChatPaidMessageRenderer);
    if (paidMessageRenderer) {
      return { kind: 'superchat', renderer: paidMessageRenderer };
    }

    const paidStickerRenderer = asRecord(item.liveChatPaidStickerRenderer);
    if (paidStickerRenderer) {
      return { kind: 'superchat', renderer: paidStickerRenderer };
    }

    const membershipRenderer = asRecord(item.liveChatMembershipItemRenderer);
    if (membershipRenderer) {
      return { kind: 'membership', renderer: membershipRenderer };
    }

    return null;
  }

  private parseRendererMessage(renderer: JsonObject, kind: ChatMessageKind): ChatMessage | null {
    const author = this.extractDisplayText(renderer.authorName);
    if (!author) {
      return null;
    }

    const authorType = this.extractAuthorType(renderer.authorBadges);
    const parsedBody = this.extractRendererBody(renderer, kind, authorType);
    if (!parsedBody) {
      return null;
    }

    const message: ChatMessage = {
      text: parsedBody.text,
      content: parsedBody.content,
      kind,
      timestamp: Date.now(),
      author,
      authorType,
    };

    const id = getString(renderer.id);
    if (id) {
      message.id = id;
    }

    const authorPhotoUrl = this.extractThumbnailUrl(renderer.authorPhoto);
    if (authorPhotoUrl) {
      message.authorPhotoUrl = authorPhotoUrl;
    }

    if (kind === 'superchat') {
      const superChatInfo = this.parseSuperChatInfo(renderer);
      if (superChatInfo) {
        message.superChat = superChatInfo;
      }
    }

    return message;
  }

  private extractRendererBody(
    renderer: JsonObject,
    kind: ChatMessageKind,
    authorType: NonNullable<ChatMessage['authorType']>
  ): ParsedMessageBody | null {
    const parsedBody =
      kind === 'membership'
        ? this.parseMembershipBody(renderer)
        : this.parseMessageContent(renderer.message);

    if (kind === 'text' && !this.isSubstantialMessage(parsedBody, authorType)) {
      return null;
    }

    return parsedBody;
  }

  private parseMembershipBody(renderer: JsonObject): ParsedMessageBody {
    const messageBody = this.parseMessageContent(renderer.message);
    return messageBody.visibleLength > 0 || messageBody.text.length > 0
      ? messageBody
      : this.parseMessageContent(renderer.headerSubtext);
  }

  private extractDisplayText(value: unknown): string | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const simpleText = getString(value.simpleText);
    if (simpleText) {
      return simpleText.trim() || undefined;
    }

    const runs = Array.isArray(value.runs) ? value.runs : [];
    const text = runs
      .map((run) => {
        if (!isRecord(run)) {
          return '';
        }

        const runText = getString(run.text);
        if (runText) {
          return runText;
        }

        const emoji = asRecord(run.emoji);
        return emoji ? this.getEmojiVisibleFallbackText(emoji) : '';
      })
      .join('')
      .trim();

    return text || undefined;
  }

  private parseMessageContent(value: unknown): ParsedMessageBody {
    if (!isRecord(value)) {
      return this.createEmptyMessageBody();
    }

    const simpleText = getString(value.simpleText);
    if (simpleText !== undefined) {
      const content: ContentSegment[] =
        simpleText.length > 0 ? [{ type: 'text', content: simpleText }] : [];
      return {
        text: this.normalizeText(simpleText),
        content,
        visibleLength: this.getVisibleContentLength(content),
      };
    }

    const runs = Array.isArray(value.runs) ? value.runs : [];
    const segments: ContentSegment[] = [];
    let plainText = '';

    for (const run of runs) {
      if (!isRecord(run)) {
        continue;
      }

      const runText = getString(run.text);
      if (runText !== undefined) {
        if (runText.length > 0) {
          this.appendTextSegment(segments, runText);
          plainText += runText;
        }
        continue;
      }

      const emojiData = asRecord(run.emoji);
      if (!emojiData) {
        continue;
      }

      const emoji = this.parseEmoji(emojiData);
      if (emoji) {
        segments.push({ type: 'emoji', emoji });
        plainText += emoji.fallbackText || '[emoji]';
        continue;
      }

      const fallbackText = this.getEmojiVisibleFallbackText(emojiData) || '[emoji]';
      this.appendTextSegment(segments, fallbackText);
      plainText += fallbackText;
    }

    return {
      text: this.normalizeText(plainText),
      content: segments,
      visibleLength: this.getVisibleContentLength(segments),
    };
  }

  private createEmptyMessageBody(): ParsedMessageBody {
    return { text: '', content: [], visibleLength: 0 };
  }

  private appendTextSegment(segments: ContentSegment[], content: string): void {
    if (content.length === 0) {
      return;
    }

    const lastSegment = segments[segments.length - 1];
    if (lastSegment?.type === 'text') {
      lastSegment.content += content;
      return;
    }

    segments.push({ type: 'text', content });
  }

  private getVisibleContentLength(segments: readonly ContentSegment[]): number {
    let visibleLength = 0;

    for (const segment of segments) {
      if (segment.type === 'emoji') {
        visibleLength += 1;
        continue;
      }

      visibleLength += Array.from(
        this.stripControlCharacters(segment.content).replace(/\s+/g, '')
      ).length;
    }

    return visibleLength;
  }

  private extractAccessibilityLabel(value: unknown): string | undefined {
    const record = asRecord(value);
    if (!record) {
      return undefined;
    }

    return (
      getString(asRecord(asRecord(record.accessibility)?.accessibilityData)?.label) || undefined
    );
  }

  private getEmojiShortcuts(emojiData: JsonObject): string[] {
    return Array.isArray(emojiData.shortcuts)
      ? emojiData.shortcuts.filter((shortcut): shortcut is string => typeof shortcut === 'string')
      : [];
  }

  private normalizeInlineText(text: string): string {
    return this.stripControlCharacters(text).replace(/\s+/g, ' ').trim();
  }

  private getEmojiAltText(emojiData: JsonObject): string {
    const shortcuts = this.getEmojiShortcuts(emojiData);

    return (
      shortcuts[0] ??
      this.extractAccessibilityLabel(emojiData.image) ??
      this.extractAccessibilityLabel(emojiData) ??
      getString(emojiData.emojiId) ??
      ''
    );
  }

  private getEmojiVisibleFallbackText(emojiData: JsonObject): string {
    const shortcuts = this.getEmojiShortcuts(emojiData);
    const nonAliasShortcut = shortcuts.find((s) => !EMOJI_ALIAS_PATTERN.test(s));
    if (nonAliasShortcut) return this.normalizeInlineText(nonAliasShortcut);

    const label =
      this.extractAccessibilityLabel(emojiData.image) ?? this.extractAccessibilityLabel(emojiData);
    if (label && !EMOJI_ALIAS_PATTERN.test(label)) return this.normalizeInlineText(label);

    return '';
  }

  private parseEmoji(emojiData: JsonObject): EmojiInfo | null {
    const emojiAsset = this.createImageAsset(
      emojiData.image,
      this.getEmojiAltText(emojiData),
      this.getEmojiVisibleFallbackText(emojiData)
    );
    if (!emojiAsset) {
      return null;
    }

    const emoji: EmojiInfo = { ...emojiAsset };

    const id = getString(emojiData.emojiId);
    if (id) {
      emoji.id = id;
    }

    return emoji;
  }

  private createImageAsset(value: unknown, alt: string, fallbackText?: string): ImageAsset | null {
    const thumbnail = this.extractBestThumbnail(value);
    if (!thumbnail) {
      return null;
    }

    const asset: ImageAsset = {
      url: thumbnail.url,
      alt,
    };

    if (thumbnail.candidateUrl) {
      asset.candidateUrl = thumbnail.candidateUrl;
    }

    if (fallbackText && fallbackText.length > 0) {
      asset.fallbackText = fallbackText;
    }

    if (thumbnail.width !== undefined) {
      asset.width = thumbnail.width;
    }

    if (thumbnail.height !== undefined) {
      asset.height = thumbnail.height;
    }

    return asset;
  }

  private extractThumbnailCandidates(value: unknown): ThumbnailCandidate[] {
    if (!isRecord(value)) {
      return [];
    }

    const thumbnails = Array.isArray(value.thumbnails)
      ? value.thumbnails
      : Array.isArray(value.sources)
        ? value.sources
        : [];

    const candidates: ThumbnailCandidate[] = [];
    const seenUrls = new Set<string>();

    for (const candidate of thumbnails) {
      if (!isRecord(candidate)) {
        continue;
      }

      const url = getString(candidate.url);
      const normalizedUrl = url ? normalizeYouTubeImageUrl(url) : null;
      if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
        continue;
      }

      seenUrls.add(normalizedUrl);
      const width = getNumber(candidate.width);
      const nextThumbnail: ThumbnailCandidate = {
        url: normalizedUrl,
      };
      if (width !== undefined) {
        nextThumbnail.width = width;
      }

      const height = getNumber(candidate.height);
      if (height !== undefined) {
        nextThumbnail.height = height;
      }

      candidates.push(nextThumbnail);
    }

    candidates.sort((left, right) => (right.width ?? 0) - (left.width ?? 0));
    return candidates;
  }

  private extractBestThumbnail(value: unknown): {
    url: string;
    candidateUrl?: string;
    width?: number;
    height?: number;
  } | null {
    const [bestThumbnail, ...fallbackThumbnails] = this.extractThumbnailCandidates(value);
    if (!bestThumbnail) {
      return null;
    }

    const firstFallback = fallbackThumbnails[0];
    return {
      ...bestThumbnail,
      ...(firstFallback ? { candidateUrl: firstFallback.url } : {}),
    };
  }

  private extractThumbnailUrl(value: unknown): string | undefined {
    return this.extractBestThumbnail(value)?.url;
  }

  private extractAuthorType(value: unknown): NonNullable<ChatMessage['authorType']> {
    let resolvedType: NonNullable<ChatMessage['authorType']> = 'normal';

    if (!Array.isArray(value)) {
      return resolvedType;
    }

    for (const badgeEntry of value) {
      const nextType = this.classifyAuthorBadge(badgeEntry);
      if (AUTHOR_TYPE_PRIORITY[nextType] > AUTHOR_TYPE_PRIORITY[resolvedType]) {
        resolvedType = nextType;
      }
    }

    return resolvedType;
  }

  private classifyAuthorBadge(value: unknown): NonNullable<ChatMessage['authorType']> {
    const badgeEntry = asRecord(value);
    if (!badgeEntry) {
      return 'normal';
    }

    const liveBadge = asRecord(badgeEntry.liveChatAuthorBadgeRenderer);
    const metadataBadge = asRecord(badgeEntry.metadataBadgeRenderer);
    const badge = liveBadge ?? metadataBadge ?? badgeEntry;
    const iconType = getString(asRecord(badge.icon)?.iconType)?.toUpperCase() ?? '';
    const style = getString(metadataBadge?.style ?? badge.style)?.toUpperCase() ?? '';
    const label = [
      getString(badge.tooltip),
      this.extractAccessibilityLabel(badge),
      this.extractAccessibilityLabel(liveBadge),
      this.extractAccessibilityLabel(metadataBadge),
    ]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();

    if (
      style.includes('MEMBERS_ONLY') ||
      isRecord(badge.customThumbnail) ||
      isRecord(liveBadge?.customThumbnail) ||
      iconType.includes('SPONSOR')
    ) {
      return 'member';
    }

    if (style.includes('VERIFIED') || iconType.includes('VERIFIED')) {
      return 'verified';
    }

    if (iconType.includes('OWNER') || label.includes('OWNER')) {
      return 'owner';
    }

    if (iconType.includes('MODERATOR') || label.includes('MODERATOR') || label.includes(' MOD ')) {
      return 'moderator';
    }

    if (label.includes('MEMBER') || label.includes('MEMBERSHIP') || label.includes('SPONSOR')) {
      return 'member';
    }

    if (label.includes('VERIFIED')) {
      return 'verified';
    }

    return 'normal';
  }

  private normalizeText(text: string): string {
    let normalized = this.stripControlCharacters(text);
    normalized = normalized.replace(/\s+/g, ' ').trim();

    if (normalized.length > 80) {
      normalized = `${normalized.substring(0, 77)}...`;
    }

    return normalized;
  }

  private stripControlCharacters(text: string): string {
    return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  }

  private isSubstantialMessage(
    body: ParsedMessageBody,
    authorType: NonNullable<ChatMessage['authorType']>
  ): boolean {
    const settings = this.getSettings?.();
    if (settings?.allowShortTextMessages) return true;
    if (authorType === 'moderator' || authorType === 'owner' || authorType === 'member')
      return true;
    if (this.hasEmojiContent(body.content) || EMOJI_TEXT_PATTERN.test(body.text)) return true;

    const minLength = Math.max(1, settings?.minTextLength ?? 3);
    return body.visibleLength >= minLength;
  }

  private hasEmojiContent(segments: readonly ContentSegment[]): boolean {
    return segments.some(
      (segment) =>
        segment.type === 'emoji' ||
        (segment.type === 'text' && EMOJI_TEXT_PATTERN.test(segment.content))
    );
  }

  private colorIntToCss(value: unknown): string | undefined {
    const intValue = getNumber(value);
    if (intValue === undefined) {
      return undefined;
    }

    const argb = intValue >>> 0;
    const alpha = ((argb >>> 24) & 0xff) / 255;
    const red = (argb >>> 16) & 0xff;
    const green = (argb >>> 8) & 0xff;
    const blue = argb & 0xff;

    if (alpha >= 0.999) {
      return `rgb(${red}, ${green}, ${blue})`;
    }

    return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`;
  }

  private parseSuperChatInfo(renderer: JsonObject): SuperChatInfo | null {
    const amount = this.extractDisplayText(renderer.purchaseAmountText);
    if (!amount) {
      log.warn('Super Chat renderer did not include purchaseAmountText');
      return null;
    }

    const backgroundColor = this.colorIntToCss(
      renderer.bodyBackgroundColor ?? renderer.backgroundColor
    );
    const headerBackgroundColor = this.colorIntToCss(renderer.headerBackgroundColor);
    const sourceColor = headerBackgroundColor || backgroundColor;
    const tier = this.determineSuperChatTier(sourceColor);

    const superChatInfo: SuperChatInfo = {
      amount,
      tier,
    };

    const currency = amount.match(/[A-Z]{3}/)?.[0];
    if (currency) {
      superChatInfo.currency = currency;
    }

    if (backgroundColor) {
      superChatInfo.backgroundColor = backgroundColor;
    }

    if (headerBackgroundColor) {
      superChatInfo.headerBackgroundColor = headerBackgroundColor;
    }

    const stickerAlt =
      this.extractAccessibilityLabel(renderer.sticker) ??
      this.extractAccessibilityLabel(renderer.headerOverlayImage) ??
      'Super Chat Sticker';
    const sticker =
      this.createImageAsset(renderer.sticker, stickerAlt) ??
      this.createImageAsset(renderer.headerOverlayImage, stickerAlt);
    if (sticker) {
      superChatInfo.sticker = sticker;
    }

    return superChatInfo;
  }

  private determineSuperChatTier(backgroundColor: string | undefined): SuperChatInfo['tier'] {
    const rgb = backgroundColor ? parseRgbColor(backgroundColor) : null;
    if (!rgb) return 'blue';

    const { r, g, b } = rgb;

    if (r > 200 && g < 100 && b < 100) return 'red';
    if (r > 200 && g < 100 && b > 80) return 'magenta';
    if (r > 200 && g > 100 && g < 150 && b < 50) return 'orange';
    if (r > 200 && g > 180 && b < 100) return 'yellow';
    if (r < 100 && g > 200 && b > 150) return 'green';
    if (r < 100 && g > 150 && b > 200) return 'cyan';
    return 'blue';
  }
}
