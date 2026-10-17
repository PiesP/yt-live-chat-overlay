// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { buildVisibleWatchHtml } from '../../../validation/windows/visible-watch.ts';

const preview = '<body><div class="player-inner">Video Player Placeholder</div></body>';
const chat =
  '<div id="chat"><yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer></div>';

describe('visible watch HTML fixture', () => {
  it.each(['Placement fixture video', 'Bitmap lifecycle fixture video', 'Upgrade fixture video'])(
    'inserts one $label player and the visible chat tree',
    (label) => {
      const html = buildVisibleWatchHtml(preview, label);
      expect(html).toContain(
        `<video aria-label="${label}" style="width:100%;height:100%"></video>`
      );
      expect(html).toContain(`${chat}</body>`);
      expect(html).not.toContain('Video Player Placeholder');
    }
  );

  it('rejects a missing player marker even when the body marker is present', () => {
    expect(() => buildVisibleWatchHtml('<body></body>', 'Placement fixture video')).toThrow(
      'Visible watch player marker changed'
    );
  });

  it('rejects a missing body marker even when the player marker is present', () => {
    expect(() =>
      buildVisibleWatchHtml(
        '<div class="player-inner">Video Player Placeholder</div>',
        'Upgrade fixture video'
      )
    ).toThrow('Visible watch body marker changed');
  });

  it('accepts the active preview fixture', () => {
    const activePreview = readFileSync(join(process.cwd(), 'test/visual/preview.html'), 'utf8');
    expect(buildVisibleWatchHtml(activePreview, 'Placement fixture video')).toContain(chat);
  });
});
