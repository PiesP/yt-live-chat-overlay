// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { AR } from './ar';
import { ES } from './es';
import { JA } from './ja';
import { KO } from './ko';
import { ZH_CN } from './zh-CN';

export { AR, ES, JA, KO, ZH_CN };

export const TRANSLATION_MAPS: Record<string, Record<string, string>> = {
  ko: KO,
  es: ES,
  ja: JA,
  'zh-CN': ZH_CN,
  ar: AR,
};

export const LANGUAGE_CODES: string[] = ['ko', 'es', 'ja', 'zh-CN', 'ar'];

/**
 * Normalize a language code and return the matching translation map.
 * Handles formats like 'ko-KR', 'ko_KR', or plain 'ko'.
 * Falls back to English (empty map) if no match is found.
 */
export function resolveLanguage(lang: string): Record<string, string> {
  const base = lang.trim().split(/[-_]/)[0]?.toLowerCase() ?? '';
  const normalized = base === 'zh' ? 'zh-CN' : base;
  return TRANSLATION_MAPS[normalized as keyof typeof TRANSLATION_MAPS] ?? {};
}
