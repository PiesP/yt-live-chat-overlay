import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const reviewedSha = '83364ae1027cf6b1761a91dcb855ea9a95c8886c';
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const reviewedFiles = 'pinned-tools.json pinned-tools.ts check-pinned-tools.ts';

function jobSection(workflow: string, job: string): string {
  const section = workflow.match(new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`))?.[0];
  if (!section) throw new Error(`Missing workflow job: ${job}`);
  return section;
}

describe('reviewed scanner helper boundary', () => {
  it('retains scanner image and freshness validation in the reviewed source', () => {
    const pins = JSON.parse(read('scripts/ci/pinned-tools.json')) as Record<string, unknown>;
    expect(Object.keys(pins).sort()).toEqual(['osv', 'semgrep']);
    expect(read('scripts/ci/pinned-tools.ts')).toContain('OSV_SCANNER_IMAGE=');
    expect(read('scripts/ci/pinned-tools.ts')).toContain('SEMGREP_IMAGE=');
    expect(read('scripts/ci/check-pinned-tools.ts')).toContain('checkOsvDigest');
    expect(read('scripts/ci/check-pinned-tools.ts')).toContain("checkRelease('semgrep'");
  });

  it('binds both active security helper copies to the published immutable revision', () => {
    expect(reviewedSha).toMatch(/^[0-9a-f]{40}$/u);
    const security = read('.github/workflows/security.yaml');
    expect(security.match(new RegExp(`ref: ${reviewedSha}`, 'gu'))).toHaveLength(2);
    expect(security.split(`for name in ${reviewedFiles}; do`)).toHaveLength(3);
    expect(security).toContain('pinned-tools.ts" env');
    expect(security).toContain('"$pinned_dir/check-pinned-tools.ts"');
    expect(security).not.toContain('install-nose.ts');
  });

  it('keeps protected workflow authority and tagged validation separate without a duplication gate', () => {
    const release = read('.github/workflows/release.yaml');
    const provenance = jobSection(release, 'provenance');
    const quality = jobSection(release, 'quality');
    const unit = jobSection(release, 'unit');
    const publish = jobSection(release, 'publish');
    expect(provenance).toContain("if: ${{ github.ref == 'refs/heads/master' }}");
    expect(provenance).toContain('name: 📥 Checkout protected workflow source');
    for (const job of [quality, unit]) {
      expect(job).toContain('ref: ${{ github.sha }}');
      expect(job).toContain('git -c advice.detachedHead=false checkout --detach "$RELEASE_SHA"');
      expect(job).toContain('git submodule update --init --recursive');
    }
    expect(publish).toContain('needs: [provenance, quality, unit, e2e, build]');
    expect(publish).toContain('name: 📥 Checkout protected publication guard');
    expect(publish).toContain(
      'run: node --experimental-strip-types scripts/release/verify-publication.ts'
    );
    expect(publish).toContain("if: ${{ steps.guard.outputs.publish == 'true' }}");
    expect(release).not.toContain('\n  duplication:\n');
  });
});
