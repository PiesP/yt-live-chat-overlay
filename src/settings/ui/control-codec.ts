// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { AuthorType, OverlaySettings } from '@app-types';
import { ROOT_SETTING_META, SHOW_AUTHOR_KEYS } from '@settings/meta';
import type { OutlineSettingKey, RootScalarSettingKey } from '@settings/schema';
import { AUTHOR_COLOR_KEYS, OUTLINE_NUMERIC_KEYS } from '@settings/schema';

export type SettingsControlTarget =
  | { group: 'outline'; key: OutlineSettingKey }
  | { group: 'color'; key: AuthorType }
  | { group: 'backgroundColor'; key: AuthorType }
  | { group: 'backgroundEnabled'; key: AuthorType }
  | { group: 'showAuthor'; key: AuthorDisplayKey }
  | { group: 'root'; key: RootScalarSettingKey };

type AuthorDisplayKey = keyof OverlaySettings['showAuthor'];

const OUTLINE_KEYS = new Set<string>(['enabled', ...OUTLINE_NUMERIC_KEYS]);
const AUTHOR_KEYS = new Set<string>(AUTHOR_COLOR_KEYS);
const SHOW_AUTHOR_KEY_SET = new Set<string>(SHOW_AUTHOR_KEYS);

function parsePrefixedKey<T extends string>(
  name: string,
  prefix: string,
  validKeys: ReadonlySet<string>
): T | null {
  if (!name.startsWith(prefix)) return null;
  const key = name.slice(prefix.length);
  return validKeys.has(key) ? (key as T) : null;
}

/** Decode a form control name into its typed settings path. */
export function parseSettingsControlName(name: string): SettingsControlTarget | null {
  const outlineKey = parsePrefixedKey<OutlineSettingKey>(name, 'outline-', OUTLINE_KEYS);
  if (outlineKey) return { group: 'outline', key: outlineKey };

  const colorKey = parsePrefixedKey<AuthorType>(name, 'color-', AUTHOR_KEYS);
  if (colorKey) return { group: 'color', key: colorKey };

  const backgroundColorKey = parsePrefixedKey<AuthorType>(name, 'backgroundColor-', AUTHOR_KEYS);
  if (backgroundColorKey) return { group: 'backgroundColor', key: backgroundColorKey };

  const backgroundEnabledKey = parsePrefixedKey<AuthorType>(
    name,
    'backgroundEnabled-',
    AUTHOR_KEYS
  );
  if (backgroundEnabledKey) return { group: 'backgroundEnabled', key: backgroundEnabledKey };

  const showAuthorKey = parsePrefixedKey<AuthorDisplayKey>(
    name,
    'showAuthor-',
    SHOW_AUTHOR_KEY_SET
  );
  if (showAuthorKey) return { group: 'showAuthor', key: showAuthorKey };

  if (name in ROOT_SETTING_META) {
    return { group: 'root', key: name as RootScalarSettingKey };
  }
  return null;
}

/** Encode a typed settings path back to its form control name. */
export function formatSettingsControlName(target: SettingsControlTarget): string {
  return target.group === 'root' ? target.key : `${target.group}-${target.key}`;
}
