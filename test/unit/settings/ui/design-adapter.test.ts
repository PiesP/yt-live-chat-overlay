// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  DESIGN_ICON_CONTRACT,
  QUIET_INSTRUMENTS_TOKENS,
} from '@piesp/browser-core/design';
import { describe, expect, it } from 'vitest';
import { SETTINGS_UI_DESIGN } from '@settings/ui/design-adapter';
import { SETTINGS_UI_STYLES } from '@settings/ui/styles';

describe('settings Quiet Instruments adapter', () => {
  it('maps the dark settings roles to shared tokens without changing renderer tokens', () => {
    expect(SETTINGS_UI_DESIGN.colorScheme).toBe('dark');
    expect(SETTINGS_UI_DESIGN.colors).toMatchObject({
      canvas: QUIET_INSTRUMENTS_TOKENS['system.dark.color.canvas'],
      surface: QUIET_INSTRUMENTS_TOKENS['system.dark.color.surface'],
      raised: QUIET_INSTRUMENTS_TOKENS['system.dark.color.raised'],
      border: QUIET_INSTRUMENTS_TOKENS['system.dark.color.border'],
      text: QUIET_INSTRUMENTS_TOKENS['system.dark.color.text'],
      textMuted: QUIET_INSTRUMENTS_TOKENS['system.dark.color.muted'],
      accent: QUIET_INSTRUMENTS_TOKENS['product.ytco.accent-dark'],
      onAccent: QUIET_INSTRUMENTS_TOKENS['product.ytco.on-accent-dark'],
      focus: QUIET_INSTRUMENTS_TOKENS['system.dark.color.focus'],
      success: QUIET_INSTRUMENTS_TOKENS['system.dark.color.success'],
      warning: QUIET_INSTRUMENTS_TOKENS['system.dark.color.warning'],
      danger: QUIET_INSTRUMENTS_TOKENS['system.dark.color.danger'],
      info: QUIET_INSTRUMENTS_TOKENS['system.dark.color.info'],
    });
    expect(SETTINGS_UI_DESIGN.colors.accent).not.toBe(SETTINGS_UI_DESIGN.colors.focus);
  });

  it('maps shared interaction metrics into the settings contract', () => {
    expect(SETTINGS_UI_DESIGN.target.minimum).toBe(
      QUIET_INSTRUMENTS_TOKENS['component.target.minimum']
    );
    expect(SETTINGS_UI_DESIGN.radius.control).toBe(
      QUIET_INSTRUMENTS_TOKENS['component.control.radius']
    );
    expect(SETTINGS_UI_DESIGN.radius.panel).toBe(
      QUIET_INSTRUMENTS_TOKENS['component.panel.radius']
    );
    expect(SETTINGS_UI_DESIGN.focus.ringWidth).toBe(
      QUIET_INSTRUMENTS_TOKENS['component.focus.ring-width']
    );
    expect(SETTINGS_UI_DESIGN.motion.standard).toBe(
      QUIET_INSTRUMENTS_TOKENS['component.motion.duration-standard']
    );
    expect(SETTINGS_UI_DESIGN.icon).toEqual({
      size: DESIGN_ICON_CONTRACT.sizes.default,
      strokeWidth: DESIGN_ICON_CONTRACT.strokeWidth,
    });
  });

  it('resolves the runtime stylesheet without installing global token CSS', () => {
    expect(SETTINGS_UI_STYLES).toContain(`color-scheme: ${SETTINGS_UI_DESIGN.colorScheme}`);
    expect(SETTINGS_UI_STYLES).toContain(`background: ${SETTINGS_UI_DESIGN.colors.surface}`);
    expect(SETTINGS_UI_STYLES).toContain(`color: ${SETTINGS_UI_DESIGN.colors.accent}`);
    expect(SETTINGS_UI_STYLES).toContain(
      `outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${SETTINGS_UI_DESIGN.colors.focus}`
    );
    expect(SETTINGS_UI_STYLES).toContain(`border-radius: ${SETTINGS_UI_DESIGN.radius.panel}`);
    expect(SETTINGS_UI_STYLES).toContain(`min-height: ${SETTINGS_UI_DESIGN.target.minimum}`);
    expect(SETTINGS_UI_STYLES).toContain(`font-size: ${SETTINGS_UI_DESIGN.icon.size}`);
    expect(SETTINGS_UI_STYLES).toContain(
      `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.danger} 55%, black)`
    );
    expect(SETTINGS_UI_STYLES).not.toContain(':root');
    expect(SETTINGS_UI_STYLES).not.toContain('.pp-design');
    expect(SETTINGS_UI_STYLES).not.toContain('--pp-');
  });
});
