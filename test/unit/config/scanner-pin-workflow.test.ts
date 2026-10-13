import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const reviewedSha = '9f040ccfd72528f683f898a4b31e94a21f5913b7';
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const reviewedFiles = 'pinned-tools.json pinned-tools.ts check-pinned-tools.ts install-nose.ts';

// The deployed workflows still use an older immutable revision until the
// scanner-only helpers land and consumers can repin the reviewed source.
describe('reviewed scanner helper boundary', () => {
  it('keeps current source scanner-only while preserving image integrity checks', () => {
    const pins = JSON.parse(read('scripts/ci/pinned-tools.json')) as Record<string, unknown>;
    expect(Object.keys(pins).sort()).toEqual(['osv', 'semgrep']);
    expect(read('scripts/ci/pinned-tools.ts')).toContain('OSV_SCANNER_IMAGE=');
    expect(read('scripts/ci/pinned-tools.ts')).toContain('SEMGREP_IMAGE=');
    expect(read('scripts/ci/check-pinned-tools.ts')).toContain('checkOsvDigest');
    expect(read('scripts/ci/check-pinned-tools.ts')).toContain("checkRelease('semgrep'");
  });

  it('binds each still active helper copy to the same full immutable revision', () => {
    expect(reviewedSha).toMatch(/^[0-9a-f]{40}$/u);
    const security = read('.github/workflows/security.yaml');
    const deep = read('.github/workflows/deep-checks.yaml');
    const release = read('.github/workflows/release.yaml');
    expect(security.match(new RegExp(`ref: ${reviewedSha}`, 'gu'))).toHaveLength(2);
    expect(deep).toContain(`trusted_sha=${reviewedSha}`);
    expect(release).toContain(`trusted_sha=${reviewedSha}`);
    expect(security.split(`for name in ${reviewedFiles}; do`)).toHaveLength(3);
    for (const workflow of [deep, release]) {
      expect(workflow).toContain(`for name in ${reviewedFiles}; do`);
      expect(workflow).toContain('git cat-file -e "$trusted_sha^{commit}"');
      expect(workflow).toContain('git show "$trusted_sha:scripts/ci/$name"');
    }
    expect(security).toContain('pinned-tools.ts" env');
    expect(security).toContain('"$pinned_dir/check-pinned-tools.ts"');
  });
});
