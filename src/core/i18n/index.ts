// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ES } from './es';
import { JA } from './ja';
import { KO } from './ko';
import { ZH } from './zh';

export { ES, JA, KO, ZH };

export const TRANSLATION_MAPS: Record<string, Record<string, string>> = {
  ko: KO,
  es: ES,
  ja: JA,
  zh: ZH,
};

export const LANGUAGE_CODES: string[] = ['ko', 'es', 'ja', 'zh'];

/**
 * Normalize a language code and return the matching translation map.
 * Handles formats like 'ko-KR', 'ko_KR', or plain 'ko'.
 * Falls back to Korean (KO) if no match is found.
 */
export function resolveLanguage(lang: string): Record<string, string> {
  const normalized = lang.trim().split(/[-_]/)[0]?.toLowerCase() ?? '';
  return TRANSLATION_MAPS[normalized as keyof typeof TRANSLATION_MAPS] ?? KO;
}
