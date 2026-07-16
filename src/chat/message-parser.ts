// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type {
  AuthorType,
  ChatMessage,
  ContentSegment,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import {
  createImageAsset,
  extractBestThumbnail,
  getEmojiVisibleFallbackText,
  parseEmoji,
} from '@chat/emoji-parser';
import {
  AUTHOR_TYPE_PRIORITY,
  colorIntToCss,
  determineSuperChatTier,
  EMOJI_TEXT_PATTERN,
  extractAccessibilityLabel,
  extractUserColor,
  hasEmojiContent,
  stripControlCharacters,
  truncateForKind,
} from '@chat/message-helpers';
import type { JsonObject } from '@chat/youtube/request';
import { asRecord, getNumber, getString, isRecord } from '@chat/youtube/request';
import { createLogger } from '@util/logging';

const log = createLogger('ChatMessageParser');

const EMPTY_MESSAGE_BODY: ParsedMessageBody = Object.freeze({
  text: '',
  content: [],
  visibleLength: 0,
});

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

  // Extract timestamp from YouTube API action if available (timestampUsec = microseconds).
  // YouTube's InnerTube API provides per-action timestamps as timestampUsec
  // (microseconds since epoch) at the action level, or inside addChatItemAction
  // (legacy format for replay).  Using this real timestamp instead of Date.now()
  // enables deterministic parsing and preserves the server-assigned message ordering.
  const actionTimestampUsec = getNumber(action.timestampUsec);
  const timestampOverride =
    actionTimestampUsec !== undefined ? Math.round(actionTimestampUsec / 1000) : undefined;

  const extraction = extractActionItem(action);
  if (!extraction) {
    return null;
  }

  const supportedRenderer = extractSupportedRenderer(extraction.item);
  if (!supportedRenderer) {
    return null;
  }

  const message = parseRendererMessage(
    supportedRenderer.renderer,
    supportedRenderer.kind,
    settings,
    timestampOverride
  );
  if (!message) {
    return null;
  }

  // Tag with the source action type so downstream renderers can implement
  // update-in-place logic for edited/deleted messages.
  message.actionType = extraction.actionType;

  if (offsetMs !== undefined) {
    message.videoOffsetMs = offsetMs;
  }
  return { message };
}

function parseRendererMessage(
  renderer: JsonObject,
  kind: ChatMessage['kind'],
  settings: Readonly<OverlaySettings>,
  timestampOverride?: number
): ChatMessage | null {
  // Allow messages without an author name (e.g., system messages, some YouTube API edge cases).
  // Fall back to empty string so the message body is still rendered.
  const author = extractDisplayText(renderer.authorName) ?? '';

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
    timestamp: timestampOverride ?? Date.now(),
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

  const authorPhotoUrl = extractBestThumbnail(renderer.authorPhoto)?.url;
  if (authorPhotoUrl) {
    message.authorPhotoUrl = authorPhotoUrl;
  }

  if (kind === 'superchat') {
    const superChatInfo = parseSuperChatInfo(renderer);
    if (!superChatInfo) {
      log.warn('chat.parser.super-chat-skip', { reason: 'no-purchase-info' });
      return null;
    }
    message.superChat = superChatInfo;
  }

  if (kind === 'membership') {
    const headerText = parseMembershipHeaderText(renderer);
    if (headerText) {
      message.membershipHeader = headerText;
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

export function isSubstantialMessage(
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

export type ActionExtraction = {
  item: JsonObject;
  actionType: 'add' | 'replace';
} | null;

export function extractActionItem(action: JsonObject): ActionExtraction {
  if (!isRecord(action)) return null;

  const addChatItemAction = asRecord(action.addChatItemAction);
  if (addChatItemAction) {
    const item = asRecord(addChatItemAction.item);
    if (item) {
      return { item, actionType: 'add' };
    }
  }

  const replaceChatItemAction = asRecord(action.replaceChatItemAction);
  if (replaceChatItemAction) {
    const item = asRecord(replaceChatItemAction.item);
    if (item) {
      return { item, actionType: 'replace' };
    }
  }

  return null;
}

export function extractSupportedRenderer(item: JsonObject): SupportedRenderer | null {
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

/**
 * Extract the membership tier/duration header text from
 * headerPrimaryText (e.g., "New Member", "Member for 12 months").
 * Returns undefined if no header text is available.
 */
function parseMembershipHeaderText(renderer: JsonObject): string | undefined {
  return extractDisplayText(renderer.headerPrimaryText);
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
      plainText += emoji.fallbackText || '\u200B';
      continue;
    }

    const fallbackText = getEmojiVisibleFallbackText(emojiData) || '\u200B';
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

export function countCodePoints(s: string): number {
  let count = 0;
  for (const _ of s) count++;
  return count;
}

export function getVisibleContentLength(segments: readonly ContentSegment[]): number {
  let visibleLength = 0;

  for (const segment of segments) {
    if (segment.type === 'emoji') {
      visibleLength += 1;
      continue;
    }

    const cleaned = stripControlCharacters(segment.content).replace(/\s+/g, '');
    visibleLength += countCodePoints(cleaned);
  }

  return visibleLength;
}

// ── Author type extraction ───────────────────────────────────────────────────
export function extractAuthorType(value: unknown): AuthorType {
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

export function classifyAuthorBadge(value: unknown): AuthorType {
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
    .filter((s): s is string => Boolean(s))
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
