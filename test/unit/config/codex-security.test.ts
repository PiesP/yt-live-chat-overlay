import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const cliDirectory = 'scripts/security/codex-security';
const policyDirectory = '.github/codex-security';
const legacyCliDirectory = ['.github', 'codex-security'].join('/');
const cliPackagePath = resolve(root, cliDirectory, 'package.json');
const cliLockPath = resolve(root, cliDirectory, 'package-lock.json');
const dependabot = readFileSync(resolve(root, '.github/dependabot.yaml'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/codex-security.yaml'), 'utf8');
const securityWorkflow = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
const helper = readFileSync(resolve(root, 'scripts/security/codex-security.sh'), 'utf8');
const classifier = readFileSync(resolve(root, 'scripts/ci/classify-workflow-changes.sh'), 'utf8');
const patcherPath = resolve(root, 'scripts/security/patch-codex-security.mjs');
const osvConfig = readFileSync(resolve(root, policyDirectory, 'osv-scanner.toml'), 'utf8');
const pinnedToolsCheck = readFileSync(resolve(root, 'scripts/ci/check-pinned-tools.sh'), 'utf8');
const securityPolicy = readFileSync(resolve(root, '.github/SECURITY.md'), 'utf8');

function jobSection(workflowSource: string, job: string): string {
  const section = workflowSource.match(
    new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
  )?.[0];
  if (!section) throw new Error(`Workflow job not found: ${job}`);
  return section;
}

type CliPackage = {
  dependencies: Record<string, string>;
  overrides?: Record<string, unknown>;
};

type LockPackage = {
  integrity?: string;
  link?: boolean;
  version?: string;
  dependencies?: Record<string, string>;
};

type CliLock = {
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
};

describe('Codex Security CLI supply-chain controls', () => {
  it('locks the exact CLI version and every installed registry package', () => {
    const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as CliPackage;
    const cliLock = JSON.parse(readFileSync(cliLockPath, 'utf8')) as CliLock;
    const declaredVersion = cliPackage.dependencies['@openai/codex-security'];

    expect(declaredVersion).toMatch(
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
    );
    expect(cliLock.lockfileVersion).toBe(3);
    expect(cliLock.packages['']?.dependencies?.['@openai/codex-security']).toBe(
      declaredVersion
    );
    expect(cliLock.packages['node_modules/@openai/codex-security']?.version).toBe(
      declaredVersion
    );

    for (const [packagePath, metadata] of Object.entries(cliLock.packages)) {
      if (packagePath === '' || metadata.link) continue;
      expect(metadata.integrity, `${packagePath} is missing an integrity digest`).toMatch(
        /^sha512-/
      );
    }
  });

  it('keeps the CLI closure under daily Dependabot monitoring', () => {
    expect(dependabot).toMatch(
      /package-ecosystem: "npm"\n\s+directory: "\/scripts\/security\/codex-security"[\s\S]*?interval: "daily"/
    );
    expect(dependabot).toContain('prefix: "chore(deps-security)"');
  });

  it('separates the dependency lock from trusted scan policy', () => {
    expect(existsSync(resolve(root, policyDirectory, 'scan.md'))).toBe(true);
    expect(existsSync(resolve(root, policyDirectory, 'threat-model.md'))).toBe(true);
    expect(existsSync(resolve(root, legacyCliDirectory, 'package.json'))).toBe(false);
    expect(existsSync(resolve(root, legacyCliDirectory, 'package-lock.json'))).toBe(false);

    for (const consumer of [dependabot, workflow, helper, classifier, pinnedToolsCheck]) {
      expect(consumer).not.toContain(`${legacyCliDirectory}/package`);
    }
  });

  it('uses the upstream PDF parser fix without a local compatibility patch', () => {
    const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as CliPackage;
    const cliLock = JSON.parse(readFileSync(cliLockPath, 'utf8')) as CliLock;

    expect(cliPackage.overrides).toBeUndefined();
    expect(cliLock.packages['node_modules/pdfjs-dist']?.version).toBe('6.2.108');
    expect(workflow).not.toContain('patch-codex-security.mjs');
    expect(helper).not.toContain('patch-codex-security.mjs');
    expect(existsSync(patcherPath)).toBe(false);
  });

  it('scopes the unpatched extract-zip advisory exception to the CLI lock', () => {
    expect(osvConfig).toContain('id = "GHSA-jmr9-qjv8-65gv"');
    expect(osvConfig).toContain('ignoreUntil = 2026-09-13');
    expect(osvConfig).toContain('rejects all symlink ZIP entries before extraction');

    const recursiveScanCount = securityWorkflow.match(/\s-r \\\n/g)?.length ?? 0;
    const configuredScanCount =
      securityWorkflow.match(/--config=\/results\/osv-scanner\.toml/g)?.length ?? 0;
    expect(recursiveScanCount).toBeGreaterThan(0);
    expect(configuredScanCount).toBe(recursiveScanCount);
    expect(securityWorkflow).not.toContain(
      '--config=/src/.github/codex-security/osv-scanner.toml'
    );
  });

  it('materializes one base policy before both pull-request scans', () => {
    const prJob = jobSection(securityWorkflow, 'osv-scan-pr');
    const baseCheckout = prJob.indexOf('name: ⏪ Checkout the PR base');
    const materializePolicy = prJob.indexOf('name: 📁 Materialize base OSV policy');
    const baseScan = prJob.indexOf('name: 🛡️ Scan dependencies before the PR');
    const headCheckout = prJob.indexOf('name: ⏩ Checkout the PR result');
    const headScan = prJob.indexOf('name: 🛡️ Scan dependencies after the PR');

    expect(baseCheckout).toBeGreaterThan(-1);
    expect(materializePolicy).toBeGreaterThan(baseCheckout);
    expect(baseScan).toBeGreaterThan(materializePolicy);
    expect(headCheckout).toBeGreaterThan(baseScan);
    expect(headScan).toBeGreaterThan(headCheckout);
    expect(prJob).toContain('[[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(prJob).toContain(
      'install -m 0600 .github/codex-security/osv-scanner.toml "$RUNNER_TEMP/osv-results/osv-scanner.toml"'
    );
    expect(prJob.match(/\.github\/codex-security\/osv-scanner\.toml/g)).toHaveLength(1);
    expect(prJob.match(/--config=\/results\/osv-scanner\.toml/g)).toHaveLength(2);
  });

  it('selects the full-scan policy from the event trust boundary before scanning', () => {
    const fullJob = jobSection(securityWorkflow, 'osv-scan-dispatch');
    const checkout = fullJob.indexOf('name: 📥 Checkout code');
    const materializePolicy = fullJob.indexOf('name: 📁 Materialize trusted OSV policy');
    const scan = fullJob.indexOf('name: 🛡️ Run OSV scan');

    expect(checkout).toBeGreaterThan(-1);
    expect(materializePolicy).toBeGreaterThan(checkout);
    expect(scan).toBeGreaterThan(materializePolicy);
    expect(fullJob).toContain('fetch-depth: 0');
    expect(fullJob).toContain('BASE_SHA: ${{ github.event.merge_group.base_sha }}');
    expect(fullJob).toContain('merge_group)');
    expect(fullJob).toContain('[[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(fullJob).toContain('git cat-file -e "$BASE_SHA^{commit}"');
    expect(fullJob).toContain(
      'git show "$BASE_SHA:$policy_path" > "$results_dir/osv-scanner.toml"'
    );
    expect(fullJob).toContain('push | schedule | workflow_dispatch)');
    expect(fullJob).toContain(
      'install -m 0600 "$policy_path" "$results_dir/osv-scanner.toml"'
    );
    expect(fullJob).toContain('--config=/results/osv-scanner.toml');
  });

  it('installs the trusted base lock before checking out pull-request source', () => {
    const trustedCheckout = workflow.indexOf('name: Check out trusted CLI lock');
    const lockedInstall = workflow.indexOf('name: Install locked Codex Security');
    const trustedPolicy = workflow.indexOf('name: Preserve trusted scan policy');
    const sourceCheckout = workflow.indexOf('name: Check out exact source revision');

    expect(trustedCheckout).toBeGreaterThan(-1);
    expect(lockedInstall).toBeGreaterThan(trustedCheckout);
    expect(trustedPolicy).toBeGreaterThan(lockedInstall);
    expect(sourceCheckout).toBeGreaterThan(trustedPolicy);
    expect(workflow).toContain(
      "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.sha }}"
    );
    expect(workflow).toContain('npm ci \\\n');
    expect(workflow).toContain(`${cliDirectory}/package-lock.json`);
    expect(workflow).not.toMatch(/\bnpm install\b/);
  });

  it('uses trusted-base policy copies as scanner control inputs', () => {
    expect(workflow).toContain('install -d -m 0700 "$policy_dir"');
    expect(workflow).toContain(
      'install -m 0600 .github/codex-security/scan.md "$policy_dir/scan.md"'
    );
    expect(workflow).toContain('POLICY_DIR: ${{ runner.temp }}/codex-security-policy');
    expect(workflow).toContain('--scan-prompt-file "$POLICY_DIR/scan.md"');
    expect(workflow).toContain('--knowledge-base "$POLICY_DIR/threat-model.md"');
    expect(workflow).toContain('--knowledge-base "$POLICY_DIR/SECURITY.md"');
    expect(workflow).toContain('--knowledge-base "$POLICY_DIR/PRIVACY.md"');
    expect(workflow).not.toContain(
      '--scan-prompt-file "$GITHUB_WORKSPACE/.github/codex-security/scan.md"'
    );
  });

  it('keys the local cache by the complete install recipe and uses the frozen install', () => {
    expect(helper).toContain(`${cliDirectory}/package.json`);
    expect(helper).toContain(`${cliDirectory}/package-lock.json`);
    expect(helper).toContain('install_digest=');
    expect(helper).toContain('cli-$cli_version-$install_digest');
    expect(helper).toContain('.install-recipe.sha256');
    expect(helper).toContain('npm ci \\\n');
    expect(helper).not.toMatch(/\bnpm install\b/);
    expect(helper).not.toContain('--package-lock=false');
  });

  it('rejects Node.js release lines outside the package engine contract', () => {
    expect(helper).toContain('case "$node_major" in');
    expect(helper).toContain('22)');
    expect(helper).toContain('24 | 26)');
    expect(helper).toContain('if ((node_minor < 13))');
  });

  it('checks release maturity from the locked CLI manifest', () => {
    expect(pinnedToolsCheck).toContain(`${cliDirectory}/package.json`);
    expect(pinnedToolsCheck).toContain(`${cliDirectory}/package-lock.json`);
    expect(pinnedToolsCheck).toContain(
      'check_npm_mature_release codex-security @openai/codex-security'
    );
  });

  it('documents the dependency and policy locations', () => {
    expect(securityPolicy).toContain('`scripts/security/codex-security/`');
    expect(securityPolicy).toContain('`.github/codex-security/`');
  });
});
