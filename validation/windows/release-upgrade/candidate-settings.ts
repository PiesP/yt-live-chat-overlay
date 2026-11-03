// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import type { Page } from '@playwright/test';

type ExportedSettings = Record<string, unknown> & {
  _version: number;
  superChatLayout: 'stacked' | 'wide';
  opacity: number;
  outline: { opacity: number } & Record<string, unknown>;
};

export type CandidateSettingsReceipt = {
  status: 'incomplete' | 'passed';
  stage: string;
  originalLayout?: string;
  selectedLayout?: string;
  textOpacityDomain?: [number, number];
  outlineOpacityDomain?: [number, number];
  originalSha256?: string;
  selectedSha256?: string;
  exportImportVerified?: boolean;
  restoredSha256?: string;
  restorationVerified?: boolean;
};

const MODAL = '#yt-chat-overlay-settings-backdrop';
const MAX_EXPORT_BYTES = 256 * 1024;

function digest(settings: ExportedSettings): string {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

function validateExport(value: unknown): asserts value is ExportedSettings {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Settings export is invalid');
  const settings = value as Record<string, unknown>;
  assert.equal(settings._version, 2, 'Settings export version changed');
  assert(
    settings.superChatLayout === 'stacked' || settings.superChatLayout === 'wide',
    'Settings export lacks a valid Super Chat layout'
  );
  assert(
    typeof settings.opacity === 'number' && settings.opacity >= 0.5 && settings.opacity <= 1,
    'Text opacity is outside its settings domain'
  );
  const outline = settings.outline;
  assert(outline && typeof outline === 'object' && !Array.isArray(outline));
  const outlineOpacity = (outline as Record<string, unknown>).opacity;
  assert(
    typeof outlineOpacity === 'number' && outlineOpacity >= 0 && outlineOpacity <= 1,
    'Outline opacity is outside its settings domain'
  );
}

async function openSettings(page: Page): Promise<void> {
  const modal = page.locator(MODAL);
  if (await modal.isVisible()) return;
  await page.locator('#yt-chat-overlay-settings-button').waitFor({ state: 'visible' });
  await page.locator('#movie_player').hover();
  await page.locator('#yt-chat-overlay-settings-button').click();
  await modal.waitFor({ state: 'visible' });
}

async function closeSettings(page: Page): Promise<void> {
  const modal = page.locator(MODAL);
  if (!(await modal.isVisible())) return;
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
}

/** Read the actual settings export. The returned bytes stay in memory for UI import. */
export async function exportSettingsThroughUi(page: Page): Promise<ExportedSettings> {
  await openSettings(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator(`${MODAL} button[data-action="export"]`).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'yt-chat-overlay-settings.json');
  const path = await download.path();
  assert(path, 'Settings export has no downloaded file');
  const size = (await stat(path)).size;
  assert(size > 0 && size <= MAX_EXPORT_BYTES, 'Settings export size is invalid');
  const bytes = await readFile(path);
  assert.equal(bytes.length, size, 'Settings export changed while reading');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Settings export is not valid JSON');
  }
  validateExport(value);
  return value;
}

async function importSettingsThroughUi(page: Page, settings: ExportedSettings): Promise<void> {
  await openSettings(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator(`${MODAL} button[data-action="import"]`).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'yt-chat-overlay-settings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(settings)),
  });
  const toast = page.locator(`${MODAL} .yt-chat-overlay-settings-toast[role="status"]`);
  await toast.waitFor({ state: 'visible' });
  assert.match(await toast.innerText(), /Settings imported for this session/i);
  await closeSettings(page);
}

async function waitForStored(
  readStored: () => Promise<unknown>,
  expected: ExportedSettings
): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    const actual = await readStored();
    validateExport(actual);
    if (isDeepStrictEqual(actual, expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.fail('Full settings export did not reach persistent storage');
}

async function reloadAndCompare(page: Page, expected: ExportedSettings): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const actual = await exportSettingsThroughUi(page);
  assert(isDeepStrictEqual(actual, expected), 'Reload lost or changed settings');
  const modal = page.locator(MODAL);
  await modal.locator('#tab-colors').click();
  assert.equal(
    await modal.locator('select[name="superChatLayout"]').inputValue(),
    expected.superChatLayout,
    'Settings UI layout does not match stored choice'
  );
  assert.equal(
    Number(await modal.locator('input[name="outline-opacity"]').inputValue()),
    expected.outline.opacity * 100,
    'Settings UI outline opacity does not match stored choice'
  );
  await modal.locator('#tab-comments').click();
  assert.equal(
    Number(await modal.locator('input[name="opacity"]').inputValue()),
    expected.opacity * 100,
    'Settings UI text opacity does not match stored choice'
  );
  await closeSettings(page);
}

/** Exercise candidate-only settings controls, save/reload, export/import, and durable rollback. */
export async function checkCandidateSettings(
  page: Page,
  readStored: () => Promise<unknown>,
  receipt: CandidateSettingsReceipt
): Promise<void> {
  let original: ExportedSettings | undefined;
  let changed = false;
  let primaryError: unknown;
  try {
    receipt.stage = 'export-original';
    original = await exportSettingsThroughUi(page);
    receipt.originalLayout = original.superChatLayout;
    receipt.originalSha256 = digest(original);
    assert.equal(original.superChatLayout, 'stacked', 'Upgraded default layout is not stacked');
    const modal = page.locator(MODAL);
    await modal.locator('#tab-comments').click();
    const textOpacity = modal.locator('input[name="opacity"]');
    assert.equal(await textOpacity.getAttribute('min'), '50');
    assert.equal(await textOpacity.getAttribute('max'), '100');
    await modal.locator('#tab-colors').click();
    const outlineOpacity = modal.locator('input[name="outline-opacity"]');
    assert.equal(await outlineOpacity.getAttribute('min'), '0');
    assert.equal(await outlineOpacity.getAttribute('max'), '100');
    receipt.textOpacityDomain = [50, 100];
    receipt.outlineOpacityDomain = [0, 100];
    const layout = modal.locator('select[name="superChatLayout"]');
    assert.equal(await layout.inputValue(), 'stacked');
    receipt.stage = 'save-wide-through-ui';
    changed = true;
    await layout.selectOption('wide');
    await outlineOpacity.fill('0');
    await outlineOpacity.blur();
    await modal.locator('#tab-comments').click();
    await textOpacity.fill('50');
    await textOpacity.blur();
    await closeSettings(page);
    const wide: ExportedSettings = {
      ...original,
      superChatLayout: 'wide',
      opacity: 0.5,
      outline: { ...original.outline, opacity: 0 },
    };
    await waitForStored(readStored, wide);
    await reloadAndCompare(page, wide);
    receipt.selectedLayout = 'wide';
    receipt.selectedSha256 = digest(wide);
    receipt.stage = 'import-original-through-ui';
    await importSettingsThroughUi(page, original);
    await waitForStored(readStored, original);
    await reloadAndCompare(page, original);
    receipt.stage = 'import-selected-through-ui';
    await importSettingsThroughUi(page, wide);
    await waitForStored(readStored, wide);
    await reloadAndCompare(page, wide);
    receipt.exportImportVerified = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (original && changed) {
      try {
        receipt.stage = 'restore-original-through-ui';
        await importSettingsThroughUi(page, original);
        await waitForStored(readStored, original);
        await reloadAndCompare(page, original);
        receipt.restoredSha256 = digest(original);
        receipt.restorationVerified = true;
      } catch (error) {
        primaryError = primaryError
          ? new AggregateError([primaryError, error], 'Candidate settings and restoration failed')
          : error;
      }
    }
  }
  if (primaryError) throw primaryError;
  receipt.stage = 'complete';
  receipt.status = 'passed';
}
