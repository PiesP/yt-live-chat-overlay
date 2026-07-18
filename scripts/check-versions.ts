import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
// BUILD_VERSION is set by CI release workflow (tag-derived via GITHUB_REF_NAME).
// When present, it takes precedence over package.json so the CI can build a
// version that hasn't been committed to package.json yet.
const expected = process.env.BUILD_VERSION || pkg.version;
let failed = false;

const checks: { file: string; pattern: RegExp; label: string }[] = [
  { file: 'extension/manifest.json', pattern: /"version":\s*"([^"]+)"/, label: 'Chrome manifest' },
  {
    file: 'extension/manifest.firefox.json',
    pattern: /"version":\s*"([^"]+)"/,
    label: 'Firefox manifest',
  },
];

for (const { file, pattern, label } of checks) {
  const content = readFileSync(resolve(process.cwd(), file), 'utf-8');
  const match = content.match(pattern);
  if (!match) {
    console.error(`✗ ${label}: version not found in ${file}`);
    failed = true;
    continue;
  }
  if (match[1] !== expected) {
    console.error(`✗ ${label}: expected ${expected}, found ${match[1]} in ${file}`);
    failed = true;
  } else {
    console.log(`✓ ${label}: ${match[1]}`);
  }
}

if (failed) {
  console.error('\nVersion mismatch detected. Run: pnpm run sync-versions');
  process.exit(1);
}
console.log('\n✓ All versions match:', expected);
