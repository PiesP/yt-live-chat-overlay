// SPDX-License-Identifier: MIT

import { renderRegularMessage, type TextBitmapCache } from '@renderer/canvas/shared';
import { resolveRegularMessageColor } from '@renderer/color-utils';
import { describe, expect, it } from 'vite-plus/test';

describe('FAR color Canvas acceptance', () => {
  it.each(['main', 'offscreen'] as const)(
    'draws supported short RGBA through the shared %s painter',
    (backend) => {
      const canvas =
        backend === 'main' ? document.createElement('canvas') : new OffscreenCanvas(160, 80);
      canvas.width = 160;
      canvas.height = 80;
      const context = canvas.getContext('2d');
      if (!context || !('fillText' in context)) throw new Error('Canvas 2D unavailable');
      const color = resolveRegularMessageColor(undefined, false, '#f008', '#fff', true);
      expect(color).toBe('rgba(201,23,23,0.5333333333333333)');
      renderRegularMessage(
        context,
        { text: 'MMMM', content: [{ type: 'text', content: 'MMMM' }] },
        0,
        0,
        {
          showAuthor: false,
          color,
          fontSize: 32,
          fontWeight: 'bold',
          fontFamily: 'Arial',
          outlineWidthPx: 0,
          outlineOpacity: 0,
          backgroundColor: '#00000000',
          messageWidth: 160,
          messageHeight: 80,
          mode: 'scroll',
        },
        {} as TextBitmapCache,
        new Map(),
        () => false,
        new Map(),
        () => false,
        () => 'bold 32px Arial',
        (text) => context.measureText(text).width
      );
      const pixels = context.getImageData(0, 0, 160, 80).data;
      let matched = false;
      for (let i = 0; i < pixels.length; i += 4) {
        if ((pixels[i + 3] ?? 0) < 100) continue;
        expect(pixels[i + 3]).toBeLessThanOrEqual(136);
        if (
          Math.abs((pixels[i] ?? 0) - 201) <= 3 &&
          Math.abs((pixels[i + 1] ?? 0) - 23) <= 3 &&
          Math.abs((pixels[i + 2] ?? 0) - 23) <= 3
        )
          matched = true;
      }
      expect(matched).toBe(true);
    }
  );
});
