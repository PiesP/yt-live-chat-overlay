import { AR } from '../../src/i18n/ar.ts';
import { EN } from '../../src/i18n/en.ts';
import { ES } from '../../src/i18n/es.ts';
import { JA } from '../../src/i18n/ja.ts';
import { KO } from '../../src/i18n/ko.ts';
import { ZH_CN } from '../../src/i18n/zh-CN.ts';

const locales = {
  en: EN,
  ko: KO,
  ja: JA,
  es: ES,
  'zh-CN': ZH_CN,
  ar: AR,
} as const;
const referenceKeys = Object.keys(EN).sort();
const referenceSet = new Set(referenceKeys);
let failed = false;

for (const [locale, messages] of Object.entries(locales)) {
  const keys = Object.keys(messages);
  const keySet = new Set(keys);
  const missing = referenceKeys.filter((key) => !keySet.has(key));
  const extra = keys.filter((key) => !referenceSet.has(key)).sort();

  if (missing.length === 0 && extra.length === 0) {
    console.log(`✅ ${locale}: ${keys.length} keys`);
    continue;
  }

  failed = true;
  console.error(`❌ ${locale}: ${keys.length} keys`);
  for (const key of missing) console.error(`  missing: ${key}`);
  for (const key of extra) console.error(`  extra: ${key}`);
}

if (failed) {
  throw new Error('Locale key parity check failed.');
}
console.log(`All ${Object.keys(locales).length} locales match (${referenceKeys.length} keys).`);
