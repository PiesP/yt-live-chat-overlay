// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

/**
 * @fileoverview Settings UI visual test for YT Live Chat Overlay.
 *
 * This test verifies that:
 * 1. The settings gear button appears on the player
 * 2. Clicking the button opens the settings modal
 * 3. The settings modal has all expected tabs (Comments, Appearance, Advanced, Translation)
 * 4. Settings can be read/written through the GM_setValue/GM_getValue mock
 *
 * Prerequisite: pnpm build:dev (dist/yt-live-chat-overlay.dev.user.js)
 * Run: pnpm exec playwright test --config test/e2e/playwright.config.ts settings-visual --headed
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { applySettings, setupOverlayPage, waitForStoredSettings } from '../fixtures/test-utils';

const BUTTON_ID = 'yt-chat-overlay-settings-button';

async function setupSettingsPage(page: Page): Promise<void> {
  await setupOverlayPage(page);
  // Wait for settings button to appear
  await page.waitForSelector(`#${BUTTON_ID}`, { timeout: 10_000 });
}

async function openSettingsModal(page: Page): Promise<void> {
  await setupSettingsPage(page);
  // The mock video can win hit-testing even while the overlay button is visible.
  // Force only this synthetic interaction; real pointer hit-testing is outside
  // the mock page's contract.
  await page.locator(`#${BUTTON_ID}`).click({ force: true });
}

test.describe('Settings UI Visual', () => {
  test('gear button appears on player', async ({ page }) => {
    await setupSettingsPage(page);
    const btn = page.locator(`#${BUTTON_ID}`);
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(20);
    expect(box!.height).toBeGreaterThan(20);
  });

  test('settings modal opens with all tabs', async ({ page }) => {
    await openSettingsModal(page);

    // Verify settings modal is visible
    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Verify all 4 tabs exist (tabs use id="tab-{paneId}" convention)
    const commentsTab = page.locator('#tab-comments');
    const colorsTab = page.locator('#tab-colors');
    const advancedTab = page.locator('#tab-advanced');
    const translationTab = page.locator('#tab-translation');

    await expect(commentsTab).toBeVisible();
    await expect(colorsTab).toBeVisible();
    await expect(advancedTab).toBeVisible();
    await expect(translationTab).toBeVisible();
  });

  test('settings modal can be closed', async ({ page }) => {
    await openSettingsModal(page);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click outside or press Escape to close
    await page.keyboard.press('Escape');
    // Modal should be dismissed
    await expect(modal).not.toBeVisible();
  });

  test('settings panel exposes a stable layout contract', async ({ page }) => {
    await openSettingsModal(page);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await expect(modal).toHaveRole('dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(modal.locator('.yt-chat-overlay-settings-close')).toBeVisible();
    await expect(modal.locator('.yt-chat-overlay-settings-tabs')).toBeVisible();

    const box = await modal.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(280);
    expect(box!.height).toBeGreaterThan(180);
  });

  for (const viewport of [{ width: 401, height: 592 }, { width: 1280, height: 720 }]) {
  test(`keeps default controls and the opacity sample visible at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openSettingsModal(page);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await modal.evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    });
    const pane = modal.locator('#pane-comments');
    const previewText = pane.locator('.yt-chat-overlay-settings-font-preview-text');
    const state = await pane.evaluate((element) => {
      const text = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-font-preview-text'
      );
      const stage = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-font-preview-stage'
      );
      const requiredControls = [
        'input[name="enabled"]',
        'select[name="danmakuMode"]',
        'input[name="fontSize"]',
        'input[name="speedPxPerSec"]',
        'input[name="opacity-slider"]',
        'input[name="opacity"]',
      ].map((selector) => element.querySelector<HTMLElement>(selector));
      if (!text || !stage || requiredControls.some((control) => control === null)) {
        throw new Error('Primary settings preview DOM is incomplete');
      }
      const paneRect = element.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      const containsVertically = (outer: DOMRect, inner: DOMRect): boolean =>
        inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
      const style = getComputedStyle(element);
      return {
        controlsVisible: requiredControls.every((control) =>
          containsVertically(paneRect, control!.getBoundingClientRect())
        ),
        maskImage: style.maskImage,
        opacity: getComputedStyle(text).opacity,
        paneBottom: paneRect.bottom,
        paneClientHeight: element.clientHeight,
        paneScrollTop: element.scrollTop,
        paneScrollHeight: element.scrollHeight,
        sampleInsidePane: containsVertically(paneRect, textRect),
        sampleInsideStage: containsVertically(stageRect, textRect),
        stageBottom: stageRect.bottom,
        stageTop: stageRect.top,
        textBottom: textRect.bottom,
        textTop: textRect.top,
        webkitMaskImage: style.getPropertyValue('-webkit-mask-image'),
      };
    });

    expect(state.maskImage).toBe('none');
    expect(state.webkitMaskImage).toBe('none');
    expect(state.opacity).toBe('1');
    expect(state.paneScrollTop).toBe(0);
    expect(state.controlsVisible, JSON.stringify(state)).toBe(true);
    expect(state.sampleInsidePane, JSON.stringify(state)).toBe(true);
    expect(state.sampleInsideStage, JSON.stringify(state)).toBe(true);
    await expect(previewText).toBeVisible();

    await expect(modal.locator('#tab-comments')).toBeFocused();
    for (const selector of [
      'input[name="enabled"]',
      'select[name="danmakuMode"]',
      'input[name="fontSize"]',
      'input[name="speedPxPerSec"]',
      'input[name="opacity-slider"]',
      'input[name="opacity"]',
      '.yt-chat-overlay-settings-disclosure > summary',
    ]) {
      await page.keyboard.press('Tab');
      await expect(modal.locator(selector)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(modal.locator('.yt-chat-overlay-settings-disclosure')).toHaveAttribute('open', '');
  });

  }

  test('keeps frequent controls prominent and previews normalized fine-tuning values', async ({
    page,
  }) => {
    await openSettingsModal(page);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    const details = modal.locator('.yt-chat-overlay-settings-disclosure');
    await expect(details).toBeVisible();
    await expect(details).not.toHaveAttribute('open', '');

    for (const name of ['fontSize', 'speedPxPerSec', 'opacity']) {
      await expect(modal.locator(`[name="${name}"]`).first()).toBeVisible();
      await expect(modal.locator(`details [name="${name}"]`)).toHaveCount(0);
    }

    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open', '');
    await modal.locator('input[name="safeTop"]').fill('20');
    await modal.locator('input[name="safeBottom"]').fill('10');
    await modal.locator('input[name="opacity"]').fill('65');

    await modal.locator('#tab-colors').click();
    const outlineEnabled = modal.locator('input[name="outline-enabled"]');
    if (!(await outlineEnabled.isChecked())) await outlineEnabled.check();
    await modal.locator('input[name="outline-widthPx"]').fill('3');
    await modal.locator('input[name="outline-opacity"]').fill('60');
    await modal.locator('#tab-comments').click();

    const preview = modal.locator('.yt-chat-overlay-settings-font-preview');
    const state = await preview.evaluate((element) => {
      const stage = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-font-preview-stage'
      );
      const text = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-font-preview-text'
      );
      const top = element.querySelector<HTMLElement>('[data-preview-zone="top"]');
      const bottom = element.querySelector<HTMLElement>('[data-preview-zone="bottom"]');
      if (!stage || !text || !top || !bottom) throw new Error('Settings preview is incomplete');
      const previewRect = element.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const stageHeight = stageRect.height;
      return {
        declaredStageHeight: stage.style.blockSize,
        message: text.textContent,
        metrics: element.querySelector('[data-preview-metrics]')?.textContent,
        opacity: text.style.opacity,
        parentHeight: previewRect.height,
        previewOverflows: element.scrollHeight > element.clientHeight + 1,
        stageHeight,
        stageOverflows: stage.scrollHeight > stage.clientHeight + 1,
        stroke: text.style.getPropertyValue('-webkit-text-stroke'),
        textBottom: text.getBoundingClientRect().bottom,
        textTop: text.getBoundingClientRect().top,
        availableBottom: bottom.getBoundingClientRect().top,
        availableTop: top.getBoundingClientRect().bottom,
        topFraction: top.getBoundingClientRect().height / stageHeight,
        bottomFraction: bottom.getBoundingClientRect().height / stageHeight,
      };
    });

    expect(state.message?.trim()).toBeTruthy();
    expect(state.metrics).toContain('65%');
    expect(state.metrics).toContain('3px / 60%');
    expect(state.opacity).toBe('0.65');
    expect(state.stroke).toBe('2.55px rgba(0, 0, 0, 0.6)');
    expect(state.previewOverflows, JSON.stringify(state)).toBe(false);
    expect(state.stageOverflows, JSON.stringify(state)).toBe(false);
    expect(state.stageHeight, JSON.stringify(state)).toBeCloseTo(
      Number.parseFloat(state.declaredStageHeight),
      0
    );
    expect(state.textTop).toBeGreaterThanOrEqual(state.availableTop - 1);
    expect(state.textBottom).toBeLessThanOrEqual(state.availableBottom + 1);
    expect(state.topFraction).toBeCloseTo(0.2, 2);
    expect(state.bottomFraction).toBeCloseTo(0.1, 2);
  });

  test('keeps the Spanish preview fully readable at 320px with the maximum font size', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await setupSettingsPage(page);
    await applySettings(page, {
      language: 'es',
      fontSize: 50,
      opacity: 0.55,
      safeTop: 0.25,
      safeBottom: 0.5,
    });
    await page.locator(`#${BUTTON_ID}`).click({ force: true });
    // The opening transform scales client rects, but not the declared block-size.
    await page.locator('dialog.yt-chat-overlay-settings-modal').evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    });

    const preview = page.locator('.yt-chat-overlay-settings-font-preview');
    await expect
      .poll(() =>
        preview.evaluate((element) => {
          const stage = element.querySelector<HTMLElement>(
            '.yt-chat-overlay-settings-font-preview-stage'
          );
          if (!stage) throw new Error('Settings preview stage is missing');
          const previewRect = element.getBoundingClientRect();
          const stageRect = stage.getBoundingClientRect();
          return {
            declaredStageHeight: stage.style.blockSize,
            parentHeight: previewRect.height,
            previewOverflows: element.scrollHeight > element.clientHeight + 1,
            stageHeight: stageRect.height,
            stageOverflows: stage.scrollHeight > stage.clientHeight + 1,
          };
        })
      )
      .toMatchObject({ previewOverflows: false, stageOverflows: false });
    const previewText = preview.locator('.yt-chat-overlay-settings-font-preview-text');
    await previewText.scrollIntoViewIfNeeded();
    const state = await preview.evaluate((element) => {
      const stage = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-font-preview-stage'
      );
      const text = element.querySelector<HTMLElement>(
        '.yt-chat-overlay-settings-font-preview-text'
      );
      const top = element.querySelector<HTMLElement>('[data-preview-zone="top"]');
      const bottom = element.querySelector<HTMLElement>('[data-preview-zone="bottom"]');
      if (!stage || !text || !top || !bottom) throw new Error('Settings preview is incomplete');
      const stageRect = stage.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      const previewRect = element.getBoundingClientRect();
      const pane = element.closest<HTMLElement>('.yt-chat-overlay-settings-pane');
      if (!pane) throw new Error('Settings pane is missing');
      const paneRect = pane.getBoundingClientRect();
      const paneStyle = getComputedStyle(pane);
      return {
        bottomFraction: bottom.getBoundingClientRect().height / stageRect.height,
        computedFontSize: getComputedStyle(text).fontSize,
        declaredStageHeight: stage.style.blockSize,
        message: text.textContent,
        opacity: getComputedStyle(text).opacity,
        overflowsHorizontally: text.scrollWidth > text.clientWidth + 1,
        maskImage: paneStyle.maskImage,
        paneCanScroll: pane.scrollHeight > pane.clientHeight + 1,
        paneScrollTop: pane.scrollTop,
        parentHeight: previewRect.height,
        previewOverflows: element.scrollHeight > element.clientHeight + 1,
        stageHeight: stageRect.height,
        stageOverflows: stage.scrollHeight > stage.clientHeight + 1,
        textBottom: textRect.bottom,
        textTop: textRect.top,
        textVisibleInPane:
          textRect.top >= paneRect.top - 1 && textRect.bottom <= paneRect.bottom + 1,
        availableBottom: bottom.getBoundingClientRect().top,
        availableTop: top.getBoundingClientRect().bottom,
        topFraction: top.getBoundingClientRect().height / stageRect.height,
      };
    });

    expect(state.message).toBe('Mensaje de chat de ejemplo');
    expect(state.computedFontSize).toBe('50px');
    expect(state.opacity).toBe('0.55');
    expect(state.overflowsHorizontally).toBe(false);
    expect(state.maskImage).toBe('none');
    expect(state.paneCanScroll).toBe(true);
    expect(state.paneScrollTop).toBeGreaterThan(0);
    expect(state.previewOverflows, JSON.stringify(state)).toBe(false);
    expect(state.stageOverflows, JSON.stringify(state)).toBe(false);
    expect(state.stageHeight, JSON.stringify(state)).toBeCloseTo(
      Number.parseFloat(state.declaredStageHeight),
      0
    );
    expect(state.textTop).toBeGreaterThanOrEqual(state.availableTop - 1);
    expect(state.textBottom).toBeLessThanOrEqual(state.availableBottom + 1);
    expect(state.textVisibleInPane, JSON.stringify(state)).toBe(true);
    expect(state.topFraction).toBeCloseTo(0.25, 2);
    expect(state.bottomFraction).toBeCloseTo(0.5, 2);
  });

  test('separates translation capability status from editable preferences', async ({
    page,
  }) => {
    await openSettingsModal(page);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await modal.locator('#tab-translation').click();
    const capability = modal.locator('.yt-chat-overlay-settings-capability');
    await expect(capability).toHaveAttribute('role', 'note');
    const supported = await capability.getAttribute('data-supported');
    expect(supported).toMatch(/^(?:true|false)$/);
    if (supported === 'true') {
      await expect(capability).toContainText('availability will be checked');
    } else {
      await expect(capability).toContainText('preference is kept');
    }
    await expect(capability).not.toContainText(/ready/i);
    await expect(modal.locator('input[name="translationEnabled"]')).toBeVisible();
    await expect(modal.locator('select[name="translationSource"]')).toBeVisible();
    await expect(modal.locator('select[name="translationTarget"]')).toBeVisible();
    const service = modal.locator('select[name="translationService"]');
    await expect(service.locator('option[value="off"]')).toHaveText('Off');
    await service.selectOption('off');
    await page.keyboard.press('Escape');
    await waitForStoredSettings(page, { translationService: 'off' });

    await page.locator(`#${BUTTON_ID}`).click({ force: true });
    await modal.locator('#tab-translation').click();
    await expect(service).toHaveValue('off');
  });

  test('author background controls expose defaults and persist a selected color', async ({
    page,
  }) => {
    await openSettingsModal(page);
    await page.locator('#tab-colors').click();

    const normalToggle = page.locator('input[name="backgroundEnabled-normal"]');
    const moderatorToggle = page.locator('input[name="backgroundEnabled-moderator"]');
    const ownerToggle = page.locator('input[name="backgroundEnabled-owner"]');
    const normalColor = page.locator('input[name="backgroundColor-normal"]');

    await expect(normalToggle).not.toBeChecked();
    await expect(moderatorToggle).toBeChecked();
    await expect(ownerToggle).toBeChecked();
    await expect(page.locator('input[name="backgroundColor-moderator"]')).toHaveValue('#1b3a6f');
    await expect(page.locator('input[name="backgroundColor-owner"]')).toHaveValue('#6b4f00');

    await normalColor.evaluate((input: HTMLInputElement) => {
      input.value = '#123456';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(normalToggle).toBeChecked();

    await page.keyboard.press('Escape');
    await waitForStoredSettings(page, {
      backgroundColors: { normal: '#12345659' },
    });
  });

  test('exports the current settings as a versioned JSON download', async ({ page }) => {
    await openSettingsModal(page);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#yt-chat-overlay-settings-backdrop button[data-action="export"]').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('yt-chat-overlay-settings.json');
    const path = await download.path();
    expect(path).toBeTruthy();

    const exported = JSON.parse(readFileSync(path!, 'utf8')) as Record<string, unknown>;
    expect(exported._version).toBe(2);
    expect(exported.enabled).toBe(true);
    expect(exported.colors).toBeTruthy();
  });

  test('imports valid JSON and applies the settings to the running overlay', async ({ page }) => {
    await openSettingsModal(page);

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#yt-chat-overlay-settings-backdrop button[data-action="import"]').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'overlay-settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ fontSize: 44, opacity: 0.6 })),
    });

    const toast = page.locator(
      '#yt-chat-overlay-settings-backdrop .yt-chat-overlay-settings-toast[role="status"]'
    );
    await expect(toast).toContainText(/Settings imported successfully/i);

    const settings = await page.evaluate(() => {
      const handle = (window as unknown as { __ytChatOverlay?: { getSettings: () => Record<string, unknown> } })
        .__ytChatOverlay;
      return handle?.getSettings();
    });
    expect(settings?.fontSize).toBe(44);
    expect(settings?.opacity).toBe(0.6);
  });
});
