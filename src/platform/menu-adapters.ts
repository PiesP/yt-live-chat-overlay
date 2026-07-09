// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform menu command registration — single function.
 *
 * Uses GM_registerMenuCommand when available (userscript context).
 * No-op in environments without Tampermonkey/Violentmonkey API.
 */

import type { MenuCommand } from '@platform/types';

/**
 * Register menu commands via GM_registerMenuCommand.
 * Safe to call in any environment — no-op when GM API is unavailable.
 */
export function registerMenuCommands(commands: MenuCommand[]): void {
  if (typeof GM_registerMenuCommand === 'undefined') return;
  for (const cmd of commands) {
    GM_registerMenuCommand(cmd.name, cmd.action);
  }
}
