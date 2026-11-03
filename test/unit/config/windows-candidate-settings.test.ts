// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vite-plus/test';

import {
  type ExportedSettings,
  waitForStoredSettings,
} from '../../../validation/windows/release-upgrade/candidate-settings.ts';

const selected: ExportedSettings = {
  _version: 2,
  superChatLayout: 'wide',
  opacity: 0.5,
  outline: { enabled: true, opacity: 0 },
  fontSize: 36,
};

describe('candidate upgrade settings storage readback', () => {
  it('retries a legacy record without the new layout until the complete save arrives', async () => {
    const legacy = { _version: 2, opacity: 0.65, outline: { enabled: true, opacity: 0.7 } };
    let reads = 0;
    await waitForStoredSettings(async () => (++reads === 1 ? legacy : selected), selected);
    expect(reads).toBe(2);
  });

  it('rejects a persistently incomplete record at the deadline', async () => {
    await expect(
      waitForStoredSettings(async () => ({ _version: 2, opacity: 0.65 }), selected, 1)
    ).rejects.toThrow('incomplete-or-invalid');
  });

  it('retries a transient read error before accepting the exact saved record', async () => {
    let reads = 0;
    await waitForStoredSettings(async () => {
      if (++reads === 1) throw new Error('Storage is still opening');
      return selected;
    }, selected);
    expect(reads).toBe(2);
  });

  it('rejects a complete record with unrelated settings loss', async () => {
    await expect(
      waitForStoredSettings(async () => ({ ...selected, fontSize: 40 }), selected, 1)
    ).rejects.toThrow('different');
  });
});
