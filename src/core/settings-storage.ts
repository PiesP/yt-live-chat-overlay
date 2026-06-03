// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Legacy re-export of storage adapter.
 *
 * The actual adapter implementations now live in @platform/storage-adapters.
 * This module is kept for backward compatibility — existing code that imports
 * `getSettingsStorageAdapter` from here continues to work.
 */

import { getStorageAdapter as getPlatformStorageAdapter } from '@platform/storage-adapters';
import type { StorageAdapter } from '@platform/types';

export type SettingsStorageAdapter = StorageAdapter;

/**
 * Returns the singleton settings storage adapter.
 * Priority: chrome.storage > GM_* > localStorage.
 */
export function getSettingsStorageAdapter(): SettingsStorageAdapter {
  return getPlatformStorageAdapter();
}
