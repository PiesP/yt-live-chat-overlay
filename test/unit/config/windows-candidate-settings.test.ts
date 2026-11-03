// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/// <reference types="node" />

import type { FileHandle } from 'node:fs/promises';

import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  type ExportedSettings,
  exportSettingsThroughUi,
  waitForStoredSettings,
} from '../../../validation/windows/release-upgrade/candidate-settings.ts';

const selected: ExportedSettings = {
  _version: 2,
  superChatLayout: 'wide',
  opacity: 0.5,
  outline: { enabled: true, opacity: 0 },
  fontSize: 36,
};

function downloadPage(filename = 'yt-chat-overlay-settings.json'): Page {
  return {
    locator: (selector: string) =>
      selector === '#yt-chat-overlay-settings-backdrop'
        ? { isVisible: async () => true }
        : { click: async () => undefined },
    waitForEvent: async () => ({
      suggestedFilename: () => filename,
      path: async () => 'downloaded-settings.json',
    }),
  } as unknown as Page;
}

function downloadedFile(
  getContents: () => Buffer,
  size: number,
  options: { chunkSize?: number; isFile?: boolean } = {}
) {
  const close = vi.fn(async () => undefined);
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const contents = getContents();
    const bytesRead = Math.min(length, options.chunkSize ?? length, contents.length - position);
    if (bytesRead > 0) contents.copy(buffer, offset, position, position + bytesRead);
    return { bytesRead, buffer };
  });
  const stat = vi.fn(async () => ({ size, isFile: () => options.isFile ?? true }));
  return { handle: { close, read, stat } as unknown as FileHandle, close, read, stat };
}

describe('candidate settings downloaded export', () => {
  it('reads the opened file identity through short reads even after its path is replaced', async () => {
    const original = Buffer.from(JSON.stringify(selected));
    let pathContents = original;
    let file: ReturnType<typeof downloadedFile> | undefined;
    const openDownload = vi.fn(async () => {
      const openedContents = pathContents;
      file = downloadedFile(() => openedContents, openedContents.length, { chunkSize: 7 });
      pathContents = Buffer.from('{"replacement":true}');
      return file.handle;
    });

    expect(await exportSettingsThroughUi(downloadPage(), openDownload)).toEqual(selected);
    expect(pathContents).not.toEqual(original);
    expect(openDownload).toHaveBeenCalledWith('downloaded-settings.json');
    expect(file?.read.mock.calls.length).toBeGreaterThan(1);
    expect(file?.close).toHaveBeenCalledOnce();
  });

  it('rejects growth beyond the byte limit and closes the handle', async () => {
    const contents = Buffer.alloc(256 * 1024 + 1, 'x');
    const file = downloadedFile(() => contents, 100);

    await expect(exportSettingsThroughUi(downloadPage(), async () => file.handle)).rejects.toThrow(
      'Settings export size is invalid'
    );
    expect(file.read).toHaveBeenCalledOnce();
    expect(file.read.mock.calls[0]?.[2]).toBe(256 * 1024 + 1);
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('rejects a short EOF and closes the handle', async () => {
    const contents = Buffer.from(JSON.stringify(selected));
    const file = downloadedFile(() => contents, contents.length + 1, { chunkSize: 5 });

    await expect(exportSettingsThroughUi(downloadPage(), async () => file.handle)).rejects.toThrow(
      'Settings export changed while reading'
    );
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('rejects a directory before reading and closes the handle', async () => {
    const contents = Buffer.from(JSON.stringify(selected));
    const file = downloadedFile(() => contents, contents.length, { isFile: false });

    await expect(exportSettingsThroughUi(downloadPage(), async () => file.handle)).rejects.toThrow(
      'Settings export size is invalid'
    );
    expect(file.read).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('keeps the required filename and JSON validation', async () => {
    const contents = Buffer.from('{invalid');
    const file = downloadedFile(() => contents, contents.length);
    await expect(
      exportSettingsThroughUi(downloadPage('wrong.json'), async () => file.handle)
    ).rejects.toThrow('yt-chat-overlay-settings.json');
    expect(file.stat).not.toHaveBeenCalled();

    await expect(exportSettingsThroughUi(downloadPage(), async () => file.handle)).rejects.toThrow(
      'Settings export is not valid JSON'
    );
    expect(file.close).toHaveBeenCalledOnce();
  });
});

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
