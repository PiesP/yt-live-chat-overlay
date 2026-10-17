// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

const PLAYER_MARKER = '<div class="player-inner">Video Player Placeholder</div>';
const BODY_MARKER = '</body>';
const CHAT_TREE =
  '<div id="chat"><yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer></div>';

/** Add a visible player and chat tree to the shared preview fixture. */
export function buildVisibleWatchHtml(preview: string, videoLabel: string): string {
  assert.equal(preview.split(PLAYER_MARKER).length, 2, 'Visible watch player marker changed');
  assert.equal(preview.split(BODY_MARKER).length, 2, 'Visible watch body marker changed');
  return preview
    .replace(
      PLAYER_MARKER,
      `<video aria-label="${videoLabel}" style="width:100%;height:100%"></video>`
    )
    .replace(BODY_MARKER, `${CHAT_TREE}${BODY_MARKER}`);
}
