import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const reviewedConsumerSha = '83364ae1027cf6b1761a91dcb855ea9a95c8886c';
const reviewedProviderSha = '4ab0442d8d2e3cf640767b499b6444c92f6479b5';
const action = `uses: PiesP/browser-core/automation/actions/prepare-scanner-pins@${reviewedProviderSha}`;
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

function jobSection(workflow: string, job: string): string {
  const section = workflow.match(new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`))?.[0];
  if (!section) throw new Error(`Missing workflow job: ${job}`);
  return section;
}

function stepSection(job: string, name: string): string {
  return job.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0] ?? '';
}

describe('reviewed scanner helper boundary', () => {
  it('retains consumer-owned scanner metadata byte-for-byte', () => {
    expect(createHash('sha256').update(read('scripts/ci/pinned-tools.json')).digest('hex')).toBe(
      'bedb4bb9a258425a93ad7b87294e9b0a304b1d708e5a46e820d59163aa566af3'
    );
    const pins = JSON.parse(read('scripts/ci/pinned-tools.json')) as Record<string, unknown>;
    expect(Object.keys(pins).sort()).toEqual(['osv', 'semgrep']);
  });

  it('binds both security jobs to the reviewed provider and YT metadata', () => {
    expect(reviewedConsumerSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(reviewedProviderSha).toMatch(/^[0-9a-f]{40}$/u);
    const security = read('.github/workflows/security.yaml');
    const selected =
      "${{ needs.changes.result != 'success' || needs.changes.outputs.pinned_tools == 'true' }}";
    for (const [name, mode] of [
      ['pin-metadata', 'env'],
      ['pinned-tools', 'check'],
    ] as const) {
      const body = jobSection(security, name);
      const checkout = body.indexOf(`ref: ${reviewedConsumerSha}`);
      const runtime = body.indexOf("install-dependencies: 'false'");
      const helper = body.indexOf(action);
      const command = body.indexOf(` ${mode} "$pin_metadata"`);
      expect(checkout).toBeGreaterThan(0);
      expect(runtime).toBeGreaterThan(checkout);
      expect(helper).toBeGreaterThan(runtime);
      expect(command).toBeGreaterThan(helper);
      expect(body).toContain('id: scanner_helper');
      expect(body).toContain('pinned_dir="$(mktemp -d "$RUNNER_TEMP/pinned-tools.XXXXXXXX")"');
      expect(body).toContain('pin_metadata="$pinned_dir/pinned-tools.json"');
      expect(body).toContain('install -m 0600 scripts/ci/pinned-tools.json "$pin_metadata"');
      expect(body).toContain('"${{ steps.scanner_helper.outputs.helper-path }}"');
      expect(body).not.toContain('continue-on-error:');
      expect(body).toContain('contents: read');
      if (name === 'pinned-tools') {
        for (const step of [
          '📥 Checkout code',
          '📦 Setup reviewed pin runtime',
          '🔐 Prepare reviewed scanner pin helper',
          '🔎 Check pinned tools after the cooling window',
        ]) {
          expect(stepSection(body, step)).toContain(`if: ${selected}`);
        }
        expect(body).toContain('GH_TOKEN: ${{ github.token }}');
      }
    }
    expect(jobSection(security, 'pin-metadata')).toContain('GITHUB_ENV="$GITHUB_OUTPUT"');
    expect(security).toContain('OSV_SCANNER_IMAGE: ${{ steps.pins.outputs.OSV_SCANNER_IMAGE }}');
    expect(security).toContain('SEMGREP_IMAGE: ${{ steps.pins.outputs.SEMGREP_IMAGE }}');
    expect(security).toContain("needs['pin-metadata'].outputs.OSV_SCANNER_IMAGE");
    expect(security).toContain("needs['pin-metadata'].outputs.SEMGREP_IMAGE");
    expect(security).not.toContain('scripts/ci/pinned-tools.ts');
    expect(security).not.toContain('check-pinned-tools.ts');
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
