import { borderRadius, colors, rgba, shadows, spacing, typography } from '@core/design-tokens';
import { RENDERER_LAYOUT } from '@core/renderer-layout';

export const RENDERER_STATIC_STYLES = `
  .yt-chat-overlay-message {
    position: absolute;
    white-space: nowrap;
    font-family: system-ui, -apple-system, sans-serif;
    font-weight: ${typography.fontWeight.bold};
    line-height: 1.1;
    text-shadow: var(--yt-overlay-message-text-shadow, none);
    -webkit-text-stroke: var(--yt-overlay-text-stroke, 0 transparent);
    color: ${colors.ui.text};
    pointer-events: none;
    will-change: transform;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
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
    font-size: ${RENDERER_LAYOUT.AUTHOR_FONT_SCALE}em;
    opacity: 0.95;
  }

  .yt-chat-overlay-author-photo {
    width: ${RENDERER_LAYOUT.AUTHOR_PHOTO_SIZE}px;
    height: ${RENDERER_LAYOUT.AUTHOR_PHOTO_SIZE}px;
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
      rgba(var(--yt-sc-rgb), var(--yt-overlay-superchat-top-opacity, 0.46)) 0%,
      rgba(var(--yt-sc-rgb), var(--yt-overlay-superchat-base-opacity, 0.4)) 48%,
      rgba(var(--yt-sc-rgb), var(--yt-overlay-superchat-bottom-opacity, 0.4)) 100%
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

  .yt-chat-overlay-message:not(.yt-chat-overlay-superchat-card) {
    text-shadow: var(--yt-overlay-regular-message-text-shadow, ${shadows.text.md});
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
    background: ${rgba(colors.superChat.green, 0.25)};
    border: 2px solid ${rgba(colors.superChat.green, 0.5)};
    box-shadow: ${shadows.box.md};
    backdrop-filter: blur(4px);
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
    color: ${colors.ui.text};
    text-shadow: ${shadows.text.sm};
  }
`;
