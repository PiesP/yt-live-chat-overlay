// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
//
// i18n Key Parity Check
// Compares all locale files against the baseline (ko.ts) and reports
// missing / extra keys so drift is caught at build time.

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const I18N_DIR = new URL('../src/core/i18n/', import.meta.url).pathname;
const BASELINE = 'ko.ts';

/**
 * Extract Record keys from an exported const declaration.
 * Parses `export const NAME: Record<string, string> = { ... }` and
 * returns the list of literal keys inside the object.
 */
function extractKeys(source: string): string[] {
  // Find the opening brace of the object literal
  const match = source.match(/export\s+const\s+\w+\s*:\s*Record\s*<[^>]*>\s*=\s*\{/);
  if (!match) {
    console.warn('  ⚠ No Record export found, skipping.');
    return [];
  }

  const start = match.index! + match[0].length - 1; // position of '{'
  let depth = 0;
  let end = start;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  const body = source.slice(start + 1, end);
  const keys: string[] = [];

  // Match lines like:  KeyName: '...'  or  'Key With Spaces': '...'
  const keyRe = /^\s*(?:(\w+)|'([^']+)'|"([^"]+)")\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    const key = m[1] ?? m[2] ?? m[3];
    if (key && !key.startsWith('//')) {
      keys.push(key);
    }
  }

  return keys;
}

// ── Gather locale files ──
const files = readdirSync(I18N_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== BASELINE)
  .sort();

const baselinePath = join(I18N_DIR, BASELINE);
const baselineKeys = new Set(extractKeys(readFileSync(baselinePath, 'utf-8')));

let totalErrors = 0;

console.log(`\n🔍 i18n Key Parity Check — baseline: ${BASELINE} (${baselineKeys.size} keys)\n`);

for (const file of files) {
  const path = join(I18N_DIR, file);
  const keys = extractKeys(readFileSync(path, 'utf-8'));
  const keySet = new Set(keys);

  const missing = [...baselineKeys].filter((k) => !keySet.has(k));
  const extra = [...keySet].filter((k) => !baselineKeys.has(k));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✅ ${file} — ${keys.length} keys (in sync)`);
  } else {
    totalErrors += missing.length + extra.length;
    console.log(`\n  ❌ ${file} — ${keys.length} keys`);
    if (missing.length > 0) {
      console.log(`     Missing (${missing.length}):`);
      for (const k of missing) console.log(`       - ${k}`);
    }
    if (extra.length > 0) {
      console.log(`     Extra (${extra.length}):`);
      for (const k of extra) console.log(`       + ${k}`);
    }
  }
}

if (totalErrors > 0) {
  console.log(`\n❌ ${totalErrors} parity issue(s) found.`);
  process.exit(1);
} else {
  console.log(`\n✅ All locale files are in parity.\n`);
}
