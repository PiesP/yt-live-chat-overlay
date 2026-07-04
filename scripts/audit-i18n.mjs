// SPDX-License-Identifier: MIT
//
// Comprehensive i18n key parity & code usage audit.
// Scans locale files and source code for t() calls,
// then reports all mismatches.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = new URL('..', import.meta.url).pathname;
const I18N_DIR = join(PROJECT, 'src/core/i18n/');
const SRC_DIR = join(PROJECT, 'src/');

// ── Extract keys from a locale file ──

function extractLocaleKeys(source) {
  const match = source.match(/export\s+const\s+\w+\s*:\s*Record\s*<[^>]*>\s*=\s*\{/);
  if (!match) return [];

  const start = match.index + match[0].length - 1;
  let depth = 0;
  let end = start;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) { end = i; break; }
  }

  const body = source.slice(start + 1, end);
  const keys = [];
  const keyRe = /^\s*(?:(['"])((?:(?!\1).)*)\1|(\w+))\s*:/gm;
  let m;
  while ((m = keyRe.exec(body)) !== null) {
    const key = m[2] ?? m[3];
    if (key) keys.push(key);
  }
  return keys;
}

// ── Locale files ──

const localeFiles = readdirSync(I18N_DIR)
  .filter(f => f.endsWith('.ts') && f !== 'index.ts')
  .sort();

const localeData = {};
for (const f of localeFiles) {
  const src = readFileSync(join(I18N_DIR, f), 'utf-8');
  const code = f.replace('.ts', '');
  localeData[code] = {
    file: f,
    keys: new Set(extractLocaleKeys(src)),
  };
}

// ── Intersection ──
// Build the union of all keys across all locales as the "master set"
const allLocaleKeys = new Set();
for (const { keys } of Object.values(localeData)) {
  for (const k of keys) allLocaleKeys.add(k);
}

console.log('## yt-live-chat-overlay Translation Audit\n');
console.log('### Key Counts\n');
for (const [code, { file, keys }] of Object.entries(localeData)) {
  console.log(`| ${code} | ${file} | ${keys.size} |`);
}
console.log(`| **All Keys (union)** | | **${allLocaleKeys.size}** |\n`);

// ── Missing per locale (union-based) ──
console.log('### Keys Missing Per Locale (relative to union of all locales)\n');
const DEFAULT_BASELINE = 'ko';
for (const [code, { keys }] of Object.entries(localeData)) {
  if (code === 'en') continue; // English is empty — no translation needed
  const missing = [...allLocaleKeys].filter(k => !keys.has(k)).sort();
  if (missing.length === 0) {
    console.log(`✅ **${code}** — fully in sync\n`);
  } else {
    console.log(`❌ **${code}** — missing ${missing.length} key(s):\n`);
    for (const k of missing) console.log(`    - \`${k}\``);
    console.log();
  }
}

// ── Scan source code for t() calls ──

function collectUsedKeys(dir) {
  const used = new Set();
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const sub = collectUsedKeys(full);
      for (const k of sub) used.add(k);
    } else if (entry.name.endsWith('.ts') && entry.name !== 'i18n.ts' && entry.name !== 'index.ts') {
      const src = readFileSync(full, 'utf-8');
      // Match all t('...') and t("...") calls
      const tCallRe = /\bt\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g;
      let m;
      while ((m = tCallRe.exec(src)) !== null) {
        const key = m[2];
        if (key) used.add(key);
      }
    }
  }
  return used;
}

const usedKeys = collectUsedKeys(SRC_DIR);

// ── Code keys not in any locale ──
const codeKeysNotInAnyLocale = [...usedKeys].filter(k => !allLocaleKeys.has(k)).sort();
const localeKeysNotInCode = [...allLocaleKeys].filter(k => !usedKeys.has(k)).sort();

console.log('### Code Keys Not In Any Locale File\n');
if (codeKeysNotInAnyLocale.length === 0) {
  console.log('✅ All code-referenced keys are present in locale files.\n');
} else {
  console.log(`⚠️  ${codeKeysNotInAnyLocale.length} key(s) from \`t()\` calls not found in ANY locale file:\n`);
  for (const k of codeKeysNotInAnyLocale) console.log(`    - \`${k}\``);
  console.log();
}

console.log('### Locale Keys Not Referenced In Code\n');
if (localeKeysNotInCode.length === 0) {
  console.log('✅ All locale keys are referenced in source code.\n');
} else {
  console.log(`⚠️  ${localeKeysNotInCode.length} key(s) in locale files but not found in any \`t()\` call in code:\n`);
  for (const k of localeKeysNotInCode) console.log(`    - \`${k}\``);
  console.log();
}

// ── Summary ──
console.log('---\n');
console.log(`**Summary:**`);
console.log(`- Total unique keys across all locales: ${allLocaleKeys.size}`);
console.log(`- Total unique keys used in code via t(): ${usedKeys.size}`);
console.log(`- Locale keys missing from code: ${localeKeysNotInCode.length}`);
console.log(`- Code keys missing from locales: ${codeKeysNotInAnyLocale.length}`);
