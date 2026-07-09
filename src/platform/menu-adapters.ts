// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform menu command registration — single function.
 *
 * Uses GM_registerMenuCommand when available (userscript context).
 * No-op in environments without Tampermonkey/Violentmonkey API.
 */

import type { MenuCommand } from '@platform/types';

/** Track registered menu command names to ensure idempotent registration. */
const registeredCommandNames = new Set<string>();

/**
 * Register menu commands via GM_registerMenuCommand.
 * Idempotent — commands with the same name are registered only once.
 * Safe to call in any environment — no-op when GM API is unavailable.
 */
export function registerMenuCommands(commands: MenuCommand[]): void {
  if (typeof GM_registerMenuCommand === 'undefined') return;
  for (const cmd of commands) {
    if (registeredCommandNames.has(cmd.name)) continue;
    registeredCommandNames.add(cmd.name);
    GM_registerMenuCommand(cmd.name, cmd.action);
  }
}

/** Reset registered commands set (for test isolation). */
export function resetRegisteredCommands(): void {
  registeredCommandNames.clear();
}
