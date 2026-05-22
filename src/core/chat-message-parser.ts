import type {
  AuthorType,
  ChatMessage,
  ContentSegment,
  ImageAsset,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import {
  colorIntToCss,
  determineSuperChatTier,
  EMOJI_ALIAS_PATTERN,
  EMOJI_TEXT_PATTERN,
  extractUserColor,
  hasEmojiContent,
  normalizeInlineText,
  stripControlCharacters,
  truncateForKind,
} from '@core/chat-message-helpers';
import { createLogger } from '@core/logging';
import { normalizeYouTubeImageUrl } from '@core/youtubei-image';
import { asRecord, getNumber, getString, isRecord, type JsonObject } from '@core/youtubei-json';

const log = createLogger('ChatMessageParser');

const EMPTY_MESSAGE_BODY: ParsedMessageBody = Object.freeze({
  text: '',
  content: [],
  visibleLength: 0,
});

const AUTHOR_TYPE_PRIORITY = {
  normal: 0,
  verified: 1,
  member: 2,
  moderator: 3,
  owner: 4,
} as const satisfies Record<AuthorType, number>;

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
  kind: ChatMessage['kind'];
  renderer: JsonObject;
}

interface ThumbnailCandidate {
  url: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract {@link ChatEvent}s from a batch of raw YouTube actions.
 *
 * @param actions  Raw action objects from the YouTube innertube response.
 * @param getSettings  Callback that returns the current overlay settings.
 */
export function extractChatEvents(
  actions: readonly unknown[],
  getSettings: () => Readonly<OverlaySettings>
): ChatEvent[] {
  const settings = getSettings();
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
        const event = parseChatEventFromAction(nestedAction, offsetMs, settings);
        if (event) {
          events.push(event);
        }
      }
      continue;
    }

    const event = parseChatEventFromAction(action, undefined, settings);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Settings-dependent pure functions (explicit parameter, no closure)
// ---------------------------------------------------------------------------

function parseChatEventFromAction(
  action: unknown,
  offsetMs: number | undefined,
  settings: Readonly<OverlaySettings>
): ChatEvent | null {
  if (!isRecord(action)) {
    return null;
  }

  const item = extractActionItem(action);
  if (!item) {
    return null;
  }

  const supportedRenderer = extractSupportedRenderer(item);
  if (!supportedRenderer) {
    return null;
  }

  const message = parseRendererMessage(
    supportedRenderer.renderer,
    supportedRenderer.kind,
    settings
  );
  if (!message) {
    return null;
  }

  return offsetMs === undefined ? { message } : { message, offsetMs };
}

function parseRendererMessage(
  renderer: JsonObject,
  kind: ChatMessage['kind'],
  settings: Readonly<OverlaySettings>
): ChatMessage | null {
  const author = extractDisplayText(renderer.authorName);
  if (!author) {
    return null;
  }

  const authorType = extractAuthorType(renderer.authorBadges);
  const userColor = extractUserColor(renderer);
  const parsedBody = extractRendererBody(renderer, kind, authorType, settings);
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

  if (userColor) {
    message.userColor = userColor;
  }

  const authorPhotoUrl = extractThumbnailUrl(renderer.authorPhoto);
  if (authorPhotoUrl) {
    message.authorPhotoUrl = authorPhotoUrl;
  }

  if (kind === 'superchat') {
    const superChatInfo = parseSuperChatInfo(renderer);
    if (superChatInfo) {
      message.superChat = superChatInfo;
    }
  }

  return message;
}

function extractRendererBody(
  renderer: JsonObject,
  kind: ChatMessage['kind'],
  authorType: AuthorType,
  settings: Readonly<OverlaySettings>
): ParsedMessageBody | null {
  const parsedBody =
    kind === 'membership'
      ? parseMembershipBody(renderer)
      : parseMessageContent(renderer.message, kind);

  if (kind === 'text' && !isSubstantialMessage(parsedBody, authorType, settings)) {
    return null;
  }

  return parsedBody;
}

function isSubstantialMessage(
  body: ParsedMessageBody,
  authorType: AuthorType,
  settings: Readonly<OverlaySettings>
): boolean {
  if (settings.allowShortTextMessages) return true;
  if (authorType === 'moderator' || authorType === 'owner' || authorType === 'member') {
    return true;
  }
  if (hasEmojiContent(body.content) || EMOJI_TEXT_PATTERN.test(body.text)) {
    return true;
  }

  const minLength = Math.max(1, settings.minTextLength);
  return body.visibleLength >= minLength;
}

function parseSuperChatInfo(renderer: JsonObject): SuperChatInfo | null {
  const amount = extractDisplayText(renderer.purchaseAmountText);
  if (!amount) {
    log.warn('Super Chat renderer did not include purchaseAmountText');
    return null;
  }

  const backgroundColor = colorIntToCss(renderer.bodyBackgroundColor ?? renderer.backgroundColor);
  const headerBackgroundColor = colorIntToCss(renderer.headerBackgroundColor);
  const sourceColor = headerBackgroundColor || backgroundColor;
  const tier = determineSuperChatTier(sourceColor);

  const superChatInfo: SuperChatInfo = {
    amount,
    tier,
  };

  if (backgroundColor) {
    superChatInfo.backgroundColor = backgroundColor;
  }

  if (headerBackgroundColor) {
    superChatInfo.headerBackgroundColor = headerBackgroundColor;
  }

  const stickerAlt =
    extractAccessibilityLabel(renderer.sticker) ??
    extractAccessibilityLabel(renderer.headerOverlayImage) ??
    'Super Chat Sticker';
  const sticker =
    createImageAsset(renderer.sticker, stickerAlt) ??
    createImageAsset(renderer.headerOverlayImage, stickerAlt);
  if (sticker) {
    superChatInfo.sticker = sticker;
  }

  return superChatInfo;
}

// ---------------------------------------------------------------------------
// Pure helper functions (module-level, no settings dependency)
// ---------------------------------------------------------------------------

function extractActionItem(action: JsonObject): JsonObject | null {
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

function extractSupportedRenderer(item: JsonObject): SupportedRenderer | null {
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

function parseMembershipBody(renderer: JsonObject): ParsedMessageBody {
  const messageBody = parseMessageContent(renderer.message);
  return messageBody.visibleLength > 0 || messageBody.text.length > 0
    ? messageBody
    : parseMessageContent(renderer.headerSubtext);
}

function extractDisplayText(value: unknown): string | undefined {
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
      return emoji ? getEmojiVisibleFallbackText(emoji) : '';
    })
    .join('')
    .trim();

  return text || undefined;
}

function parseMessageContent(
  value: unknown,
  kind: ChatMessage['kind'] = 'text'
): ParsedMessageBody {
  if (!isRecord(value)) {
    return EMPTY_MESSAGE_BODY;
  }

  const simpleText = getString(value.simpleText);
  if (simpleText !== undefined) {
    const content: ContentSegment[] =
      simpleText.length > 0 ? [{ type: 'text', content: simpleText }] : [];
    return {
      text: truncateForKind(simpleText, kind),
      content,
      visibleLength: getVisibleContentLength(content),
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
        appendTextSegment(segments, runText);
        plainText += runText;
      }
      continue;
    }

    const emojiData = asRecord(run.emoji);
    if (!emojiData) {
      continue;
    }

    const emoji = parseEmoji(emojiData);
    if (emoji) {
      segments.push({ type: 'emoji', emoji });
      plainText += emoji.fallbackText || '[emoji]';
      continue;
    }

    const fallbackText = getEmojiVisibleFallbackText(emojiData) || '[emoji]';
    appendTextSegment(segments, fallbackText);
    plainText += fallbackText;
  }

  return {
    text: truncateForKind(plainText, kind),
    content: segments,
    visibleLength: getVisibleContentLength(segments),
  };
}

function appendTextSegment(segments: ContentSegment[], content: string): void {
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

function getVisibleContentLength(segments: readonly ContentSegment[]): number {
  let visibleLength = 0;

  for (const segment of segments) {
    if (segment.type === 'emoji') {
      visibleLength += 1;
      continue;
    }

    visibleLength += [...stripControlCharacters(segment.content).replace(/\s+/g, '')].length;
  }

  return visibleLength;
}

function extractAccessibilityLabel(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return getString(asRecord(asRecord(record.accessibility)?.accessibilityData)?.label);
}

function getEmojiShortcuts(emojiData: JsonObject): string[] {
  return Array.isArray(emojiData.shortcuts)
    ? emojiData.shortcuts.filter((shortcut): shortcut is string => typeof shortcut === 'string')
    : [];
}

function getEmojiAltText(emojiData: JsonObject): string {
  const shortcuts = getEmojiShortcuts(emojiData);

  return (
    shortcuts[0] ??
    extractAccessibilityLabel(emojiData.image) ??
    extractAccessibilityLabel(emojiData) ??
    getString(emojiData.emojiId) ??
    ''
  );
}

function getEmojiVisibleFallbackText(emojiData: JsonObject): string {
  const shortcuts = getEmojiShortcuts(emojiData);
  const aliasPattern = EMOJI_ALIAS_PATTERN;
  const nonAliasShortcut = shortcuts.find((s) => !aliasPattern.test(s));
  if (nonAliasShortcut) return normalizeInlineText(nonAliasShortcut);

  const label = extractAccessibilityLabel(emojiData.image) ?? extractAccessibilityLabel(emojiData);
  if (label && !aliasPattern.test(label)) {
    return normalizeInlineText(label);
  }

  return '';
}

function parseEmoji(emojiData: JsonObject): ImageAsset | null {
  const emojiAsset = createImageAsset(
    emojiData.image,
    getEmojiAltText(emojiData),
    getEmojiVisibleFallbackText(emojiData)
  );
  if (!emojiAsset) {
    return null;
  }

  return emojiAsset;
}

function createImageAsset(value: unknown, alt: string, fallbackText?: string): ImageAsset | null {
  const thumbnail = extractBestThumbnail(value);
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

function extractThumbnailCandidates(value: unknown): ThumbnailCandidate[] {
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

function extractBestThumbnail(value: unknown): {
  url: string;
  candidateUrl?: string;
  width?: number;
  height?: number;
} | null {
  const [bestThumbnail, ...fallbackThumbnails] = extractThumbnailCandidates(value);
  if (!bestThumbnail) {
    return null;
  }

  const firstFallback = fallbackThumbnails[0] ?? null;
  return {
    ...bestThumbnail,
    ...(firstFallback ? { candidateUrl: firstFallback.url } : {}),
  };
}

function extractThumbnailUrl(value: unknown): string | undefined {
  return extractBestThumbnail(value)?.url;
}

function extractAuthorType(value: unknown): AuthorType {
  let resolvedType: AuthorType = 'normal';

  if (!Array.isArray(value)) {
    return resolvedType;
  }

  for (const badgeEntry of value) {
    const nextType = classifyAuthorBadge(badgeEntry);
    if (AUTHOR_TYPE_PRIORITY[nextType] > AUTHOR_TYPE_PRIORITY[resolvedType]) {
      resolvedType = nextType;
    }
  }

  return resolvedType;
}

function classifyAuthorBadge(value: unknown): AuthorType {
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
    extractAccessibilityLabel(badge),
    extractAccessibilityLabel(liveBadge),
    extractAccessibilityLabel(metadataBadge),
  ]
    .filter((s): s is string => !!s)
    .join(' ')
    .toUpperCase();

  // Owner badges take highest priority.
  if (iconType.includes('OWNER') || label.includes('OWNER')) {
    return 'owner';
  }

  // Moderator badges.
  if (iconType.includes('MODERATOR') || label.includes('MODERATOR') || label.includes(' MOD ')) {
    return 'moderator';
  }

  // Member badges: sponsor icon, membership style, custom thumbnail, or label hints.
  if (
    iconType.includes('SPONSOR') ||
    style.includes('MEMBERS_ONLY') ||
    isRecord(badge.customThumbnail) ||
    isRecord(liveBadge?.customThumbnail) ||
    label.includes('MEMBER') ||
    label.includes('MEMBERSHIP') ||
    label.includes('SPONSOR')
  ) {
    return 'member';
  }

  // Verified badges (channel verification).
  if (style.includes('VERIFIED') || iconType.includes('VERIFIED') || label.includes('VERIFIED')) {
    return 'verified';
  }

  return 'normal';
}
