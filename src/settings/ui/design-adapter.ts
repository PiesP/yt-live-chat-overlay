// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { DESIGN_ICON_CONTRACT, QUIET_INSTRUMENTS_TOKENS } from '@piesp/browser-core/design';

const tokens = QUIET_INSTRUMENTS_TOKENS;

/**
 * Quiet Instruments roles used by the settings UI.
 *
 * The overlay renderer keeps its own content palette and geometry. This adapter
 * deliberately resolves only the dark settings surface so the runtime-created
 * stylesheet does not need to install global design-token CSS on YouTube.
 */
export const SETTINGS_UI_DESIGN = {
  colorScheme: 'dark',
  colors: {
    canvas: tokens['system.dark.color.canvas'],
    surface: tokens['system.dark.color.surface'],
    raised: tokens['system.dark.color.raised'],
    border: tokens['system.dark.color.border'],
    text: tokens['system.dark.color.text'],
    textMuted: tokens['system.dark.color.muted'],
    accent: tokens['product.ytco.accent-dark'],
    onAccent: tokens['product.ytco.on-accent-dark'],
    focus: tokens['system.dark.color.focus'],
    success: tokens['system.dark.color.success'],
    warning: tokens['system.dark.color.warning'],
    danger: tokens['system.dark.color.danger'],
    info: tokens['system.dark.color.info'],
  },
  radius: {
    small: tokens['reference.radius.sm'],
    control: tokens['component.control.radius'],
    panel: tokens['component.panel.radius'],
    full: tokens['reference.radius.full'],
  },
  motion: {
    fast: tokens['component.motion.duration-fast'],
    standard: tokens['component.motion.duration-standard'],
    deliberate: tokens['component.motion.duration-deliberate'],
    easing: tokens['component.motion.easing-standard'],
  },
  focus: {
    ringWidth: tokens['component.focus.ring-width'],
    ringOffset: tokens['component.focus.ring-offset'],
  },
  icon: {
    size: DESIGN_ICON_CONTRACT.sizes.default,
    strokeWidth: DESIGN_ICON_CONTRACT.strokeWidth,
  },
  target: {
    minimum: tokens['component.target.minimum'],
    compactControlHeight: tokens['component.control.height-compact'],
  },
  shadow: {
    floating: tokens['component.panel.shadow'],
  },
} as const;
