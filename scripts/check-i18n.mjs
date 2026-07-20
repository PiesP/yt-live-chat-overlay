/**
 * check-i18n: Verify that all locale TypeScript files have identical key sets.
 * Run via: node scripts/check-i18n.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const i18nDir = resolve(__dirname, '..', 'src', 'i18n');

const files = readdirSync(i18nDir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
if (files.length === 0) {
  console.error('No locale TS files found in src/i18n/');
  process.exit(1);
}

/** Extract keys from a Record<string,string> TS locale file. */
function extractKeys(content) {
  const keys = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\s+'([^']+)':/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

// Load en.ts as reference (this should exist after dot-notation migration)
const enFile = files.find((f) => f === 'en.ts');
if (!enFile) {
  console.error('No en.ts file found — dot-notation migration may not be complete');
  process.exit(1);
}

const enContent = readFileSync(resolve(i18nDir, 'en.ts'), 'utf-8');
const enKeys = new Set(extractKeys(enContent));

let hasErrors = false;

for (const file of files) {
  if (file === 'en.ts') continue;
  const data = readFileSync(resolve(i18nDir, file), 'utf-8');
  const localeKeys = new Set(extractKeys(data));

  const missing = [...enKeys].filter((k) => !localeKeys.has(k));
  if (missing.length > 0) {
    console.error(`❌ ${file}: missing ${missing.length} keys:`);
    for (const k of missing) console.error(`  - ${k}`);
    hasErrors = true;
  }

  const extra = [...localeKeys].filter((k) => !enKeys.has(k));
  if (extra.length > 0) {
    console.error(`❌ ${file}: ${extra.length} extra keys:`);
    for (const k of extra) console.error(`  - ${k}`);
    hasErrors = true;
  }
}

if (hasErrors) process.exit(1);
console.log(`✅ All ${files.length} locale files have identical key sets (${enKeys.size} keys)`);
