// SPDX-License-Identifier: MIT
// Translation completeness verification script
// Parses src/core/i18n/*.ts files and verifies all locales have identical keys
// English is the source-of-truth (implicit), so we compare all non-English locales
// against each other and report any inconsistencies.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const I18N_DIR = join(ROOT, 'src', 'core', 'i18n');
const LOCALES = ['ar', 'es', 'ja', 'ko', 'zh-CN'] as const;

type LocaleKeyMap = Record<string, Set<string>>;

/**
 * Extract all keys from a flat Record<string, string> object literal.
 * These files have the structure: export const XX: Record<string, string> = { Key: 'value', ... }
 */
function extractKeys(content: string): Set<string> {
  const keys = new Set<string>();

  // Find the exported object literal
  const objectMatch = /export\s+const\s+\w+\s*:\s*Record<string,\s*string>\s*=\s*\{/.exec(content);
  if (!objectMatch) return keys;

  const openBraceIdx = objectMatch.index + objectMatch[0].length - 1;
  const extracted = extractObjectContent(content, openBraceIdx);
  if (!extracted) return keys;

  parseFlatObject(extracted.content, keys);
  return keys;
}

/**
 * Given the index of an opening {, find the matching closing }
 */
function extractObjectContent(content: string, openBraceIdx: number): { content: string } | null {
  if (content[openBraceIdx] !== '{') return null;

  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let i = openBraceIdx; i < content.length; i++) {
    const ch = content[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { content: content.slice(openBraceIdx + 1, i) };
      }
    }
  }

  return null;
}

/**
 * Parse a flat object with string keys (possibly unquoted identifiers)
 */
function parseFlatObject(content: string, keys: Set<string>): void {
  let i = 0;
  while (i < content.length) {
    // Skip whitespace
    while (i < content.length && /[\s\n\r]/.test(content[i])) i++;
    if (i >= content.length) break;

    // Skip single-line comments
    if (content[i] === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }

    // Skip multi-line comments
    if (content[i] === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }

    // Skip whitespace
    while (i < content.length && /[\s\n\r]/.test(content[i])) i++;
    if (i >= content.length) break;

    // Read key (identifier or quoted string)
    let key: string;
    if (content[i] === "'" || content[i] === '"') {
      const quote = content[i];
      let j = i + 1;
      while (j < content.length && content[j] !== quote) {
        if (content[j] === '\\') j++;
        j++;
      }
      key = content.slice(i + 1, j);
      i = j + 1;
    } else {
      // Identifier key (e.g., Comments, Appearance)
      let j = i;
      while (j < content.length && /[\w$]/.test(content[j])) j++;
      if (j === i) { i++; continue; }
      key = content.slice(i, j);
      i = j;
    }

    // Skip whitespace
    while (i < content.length && /\s/.test(content[i])) i++;

    // Read colon
    if (content[i] === ':') {
      i++;
      while (i < content.length && /\s/.test(content[i])) i++;
    } else {
      continue;
    }

    if (i >= content.length) break;

    // Read value (string)
    if (content[i] === "'" || content[i] === '"') {
      const quote = content[i];
      let j = i + 1;
      while (j < content.length && content[j] !== quote) {
        if (content[j] === '\\') j++;
        j++;
      }
      keys.add(key);
      i = j + 1;
    } else if (content[i] === '`') {
      // Template literal
      let j = i + 1;
      while (j < content.length && content[j] !== '`') {
        if (content[j] === '\\') j++;
        else if (content[j] === '$' && content[j + 1] === '{') {
          let tdepth = 1;
          j += 2;
          while (j < content.length && tdepth > 0) {
            if (content[j] === '{') tdepth++;
            else if (content[j] === '}') tdepth--;
            if (tdepth > 0) j++;
          }
          if (tdepth === 0) j++;
        }
        if (j < content.length && content[j] !== '`') j++;
      }
      keys.add(key);
      i = j + 1;
    } else {
      // Skip other values
      i++;
    }

    // Skip comma and whitespace
    while (i < content.length && /[\s,]/.test(content[i])) i++;
  }
}

function main(): void {
  console.log('═══ yt-live-chat-overlay i18n Verification ═══\n');

  const localeKeys: LocaleKeyMap = {};
  const files = readdirSync(I18N_DIR).filter((f) => f.endsWith('.ts'));

  for (const locale of LOCALES) {
    const fileName = `${locale}.ts`;
    const filePath = join(I18N_DIR, fileName);

    if (!files.includes(fileName)) {
      console.error(`❌ Missing locale file: ${fileName}`);
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');
    localeKeys[locale] = extractKeys(content);
    console.log(`  ${locale}: ${localeKeys[locale].size} keys`);
  }

  // Use ar as reference (first locale alphabetically)
  const referenceLocale = 'ar';
  const reference = localeKeys[referenceLocale];
  if (!reference) {
    console.error(`\n❌ Reference locale (${referenceLocale}) not found!`);
    process.exit(1);
  }

  console.log(`\n📊 Reference (${referenceLocale}): ${reference.size} keys\n`);

  let allMatch = true;
  const allKeys = new Set<string>();

  for (const locale of LOCALES) {
    const keys = localeKeys[locale];
    if (!keys) continue;

    const missingInLocale = [...reference].filter((k) => !keys.has(k));
    const extraInLocale = [...keys].filter((k) => !reference.has(k));

    for (const k of reference) allKeys.add(k);
    for (const k of keys) allKeys.add(k);

    if (missingInLocale.length === 0 && extraInLocale.length === 0) {
      console.log(`✅ ${locale}: MATCH (${keys.size} keys)`);
    } else {
      allMatch = false;
      console.log(`❌ ${locale}: MISMATCH`);
      if (missingInLocale.length > 0) {
        console.log(`   Missing ${missingInLocale.length} key(s): ${missingInLocale.slice(0, 5).map((k) => `"${k}"`).join(', ')}${missingInLocale.length > 5 ? '...' : ''}`);
      }
      if (extraInLocale.length > 0) {
        console.log(`   Extra ${extraInLocale.length} key(s): ${extraInLocale.slice(0, 5).map((k) => `"${k}"`).join(', ')}${extraInLocale.length > 5 ? '...' : ''}`);
      }
    }
  }

  console.log(`\n📈 Total unique keys across all locales: ${allKeys.size}`);

  if (allMatch) {
    console.log('\n✅ ALL LOCALES COMPLETE — all locales have identical key sets.\n');
    process.exit(0);
  } else {
    console.log('\n❌ TRANSLATION COMPLETENESS ISSUES DETECTED.\n');
    process.exit(1);
  }
}

main();
