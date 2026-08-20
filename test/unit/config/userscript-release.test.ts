// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('userscript release metadata', () => {
  it('uses versioned release downloads and provenance-gated latest metadata', () => {
    const config = readFileSync(resolve(root, 'tooling/vite/configs/userscript.ts'), 'utf8');

    expect(config).toContain('/releases/download/v${baseVersion}/yt-live-chat-overlay.user.js');
    expect(config).toContain('/releases/latest/download/yt-live-chat-overlay.meta.js');
    expect(config).not.toContain('@release');
    expect(config).not.toContain('jsdelivr');
  });
});
