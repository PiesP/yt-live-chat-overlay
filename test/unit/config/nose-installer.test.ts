import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const reviewedSha = '9f040ccfd72528f683f898a4b31e94a21f5913b7';
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const reviewed = (path: string): string =>
  execFileSync('git', ['show', `${reviewedSha}:${path}`], { cwd: root, encoding: 'utf8' });

// The currently deployed workflows materialize this older immutable helper set.
// Keep the compatibility fixture until the clean helper revision lands and consumers repin.
describe('reviewed scanner helper boundary', () => {
  it('keeps current source scanner-only while preserving image integrity checks', () => {
    const pins = JSON.parse(read('scripts/ci/pinned-tools.json')) as Record<string, unknown>;
    expect(Object.keys(pins).sort()).toEqual(['osv', 'semgrep']);
    expect(read('scripts/ci/pinned-tools.ts')).toContain('OSV_SCANNER_IMAGE=');
    expect(read('scripts/ci/pinned-tools.ts')).toContain('SEMGREP_IMAGE=');
    expect(read('scripts/ci/check-pinned-tools.ts')).toContain('checkOsvDigest');
    expect(read('scripts/ci/check-pinned-tools.ts')).toContain("checkRelease('semgrep'");
  });

  it('binds still active workflows to a complete, immutable reviewed helper closure', () => {
    const security = read('.github/workflows/security.yaml');
    const deep = read('.github/workflows/deep-checks.yaml');
    const release = read('.github/workflows/release.yaml');
    for (const path of [
      'scripts/ci/pinned-tools.json',
      'scripts/ci/pinned-tools.ts',
      'scripts/ci/check-pinned-tools.ts',
      'scripts/ci/install-nose.ts',
    ])
      expect(reviewed(path)).toBeTruthy();
    expect(security).toContain(`ref: ${reviewedSha}`);
    expect(deep).toContain(`trusted_sha=${reviewedSha}`);
    expect(release).toContain(`trusted_sha=${reviewedSha}`);
    expect(security).toContain('pinned-tools.ts" env');
    expect(security).toContain('"$pinned_dir/check-pinned-tools.ts"');
    expect(deep).toContain('git show "$trusted_sha:scripts/ci/$name"');
    expect(release).toContain('git show "$trusted_sha:scripts/ci/$name"');
  });
});
