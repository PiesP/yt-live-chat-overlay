import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const fixtureRoot = join(root, 'test/fixtures/scanner-provider');
const providerFiles = [
  [
    'automation/actions/prepare-scanner-pins/action.yaml',
    'action.yaml.txt',
    'f37c9657f724fcc4b39cc28294618ac0ef09d949d94aa2e757507e1f830d2adf',
  ],
  [
    'automation/actions/prepare-scanner-pins/prepare.ts',
    'prepare.ts.txt',
    '0bb6ec52113c17e4cebe86e3da792a8b59c6125cc85cfda4d037741ce7dc812b',
  ],
  [
    'automation/security/scanner-pins.ts',
    'scanner-pins.ts.txt',
    '4975feec038d3969dc38fcd1de73afba04cb84e8cd8e176de9ed8a4a81f7b7a9',
  ],
] as const;
const roots: string[] = [];

type Pins = {
  osv: { version: string; image: string };
  semgrep: { version: string; image: string };
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yt scanner consumer '));
  roots.push(directory);
  const providerRoot = join(directory, 'reviewed provider');
  const trustedCheckout = join(directory, 'reviewed consumer');
  const candidateCheckout = join(directory, 'candidate checkout');
  const runner = join(directory, 'runner temp');
  const bin = join(directory, 'bin');
  for (const path of [trustedCheckout, candidateCheckout, runner, bin]) mkdirSync(path);
  for (const [relative, name] of providerFiles) {
    const target = join(providerRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(fixtureRoot, name), target);
  }
  const trustedJson = join(trustedCheckout, 'scripts/ci/pinned-tools.json');
  mkdirSync(dirname(trustedJson), { recursive: true });
  copyFileSync(join(root, 'scripts/ci/pinned-tools.json'), trustedJson);
  mkdirSync(join(candidateCheckout, 'scripts/ci'), { recursive: true });
  writeFileSync(join(candidateCheckout, 'scripts/ci/pinned-tools.json'), '{}');
  const pins = JSON.parse(readFileSync(trustedJson, 'utf8')) as Pins;
  const mock = join(bin, 'mock');
  writeFileSync(
    mock,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const file = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.MOCK_SCENARIO || '';
const pins = JSON.parse(fs.readFileSync(process.env.TRUSTED_PIN_JSON, 'utf8'));
fs.appendFileSync(process.env.CALLS, JSON.stringify({file, args}) + '\\n');
if (file === 'gh') {
  if (scenario === 'api-fail' && args[1].includes('google/osv-scanner')) process.exit(7);
  const version = args[1].includes('google/osv-scanner') ? pins.osv.version : pins.semgrep.version;
  const published = new Date(Date.now() - (scenario === 'young' ? 1 : 48) * 3600000).toISOString();
  process.stdout.write(JSON.stringify([{tag_name:'v' + version,published_at:published,draft:false,prerelease:false}]));
} else if (file === 'curl') {
  if (args.some((arg) => arg.includes('ghcr.io/token'))) {
    process.stdout.write(JSON.stringify({token:'fixture-bearer-token'}));
  } else if (scenario === 'manifest-fail') {
    process.exit(7);
  } else {
    process.stdout.write('Docker-Content-Digest: ' + (scenario === 'digest-mismatch' ? 'sha256:' + '0'.repeat(64) : pins.osv.image.split('@')[1]) + '\\r\\n');
  }
}
`
  );
  chmodSync(mock, 0o755);
  for (const name of ['gh', 'curl']) copyFileSync(mock, join(bin, name));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RUNNER_TEMP: runner,
    GITHUB_OUTPUT: join(directory, 'github output'),
    GITHUB_ENV: join(directory, 'github env'),
    GH_TOKEN: 'fixture-gh-token',
    TRUSTED_PIN_JSON: trustedJson,
    CALLS: join(directory, 'calls.jsonl'),
  };
  const prepare = () =>
    spawnSync(
      process.execPath,
      [join(providerRoot, 'automation/actions/prepare-scanner-pins/prepare.ts')],
      { cwd: candidateCheckout, env, encoding: 'utf8' }
    );
  const helperPath = () =>
    readFileSync(env.GITHUB_OUTPUT, 'utf8').match(/^helper-path=(.+)$/mu)?.[1] ?? '';
  const copyMetadata = () => {
    const path = join(mkdtempSync(join(runner, 'pinned-tools.')), 'pinned-tools.json');
    copyFileSync(trustedJson, path);
    chmodSync(path, 0o600);
    return path;
  };
  const run = (helper: string, mode: string, metadata: string, scenario = '') => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', helper, mode, metadata],
      { cwd: candidateCheckout, env: { ...env, MOCK_SCENARIO: scenario }, encoding: 'utf8' }
    );
    const calls = existsSync(env.CALLS)
      ? readFileSync(env.CALLS, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { file: string; args: string[] })
      : [];
    return { result, calls };
  };
  return {
    candidateCheckout,
    env,
    helperPath,
    pins,
    prepare,
    copyMetadata,
    run,
    runner,
    trustedJson,
  };
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('reviewed scanner provider in the YT security workflow boundary', () => {
  it('binds reviewed provider bytes and prepares only a private helper', () => {
    for (const [, name, hash] of providerFiles) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(fixtureRoot, name)))
          .digest('hex')
      ).toBe(hash);
    }
    const action = readFileSync(join(fixtureRoot, 'action.yaml.txt'), 'utf8');
    expect(action).toContain('run: node "$GITHUB_ACTION_PATH/prepare.ts"');
    expect(action).toContain('value: ${{ steps.prepare.outputs.helper-path }}');
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const helper = f.helperPath();
    expect(dirname(helper).startsWith(`${f.runner}/scanner-pin-helper-`)).toBe(true);
    expect(readdirSync(dirname(helper))).toEqual(['scanner-pins.ts']);
    if (process.platform !== 'win32') {
      expect(lstatSync(dirname(helper)).mode & 0o777).toBe(0o700);
      expect(lstatSync(helper).mode & 0o777).toBe(0o600);
    }
  });

  it('runs both modes using reviewed YT metadata from an unrelated checkout', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const snapshot = f.copyMetadata();
    if (process.platform !== 'win32') {
      expect(lstatSync(dirname(snapshot)).mode & 0o777).toBe(0o700);
      expect(lstatSync(snapshot).mode & 0o777).toBe(0o600);
    }
    const exported = f.run(f.helperPath(), 'env', snapshot);
    expect(exported.result.status, exported.result.stderr).toBe(0);
    expect(exported.calls).toEqual([]);
    expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe(
      `OSV_SCANNER_IMAGE=${f.pins.osv.image}\nSEMGREP_IMAGE=${f.pins.semgrep.image}\n`
    );
    const checked = f.run(f.helperPath(), 'check', snapshot);
    expect(checked.result.status, checked.result.stderr).toBe(0);
    expect(checked.calls.map(({ file }) => file)).toEqual(['gh', 'curl', 'curl', 'gh']);
    expect(checked.calls[0]?.args).toContain('repos/google/osv-scanner/releases?per_page=100');
    expect(checked.calls[3]?.args).toContain('repos/semgrep/semgrep/releases?per_page=100');
    expect(readFileSync(join(f.candidateCheckout, 'scripts/ci/pinned-tools.json'), 'utf8')).toBe(
      '{}'
    );
  });

  it('fails before commands or outputs for missing helper, bad metadata and relative paths', () => {
    const f = fixture();
    const snapshot = f.copyMetadata();
    expect(f.run(join(f.runner, 'missing.ts'), 'env', snapshot).result.status).not.toBe(0);
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
    expect(f.prepare().status).toBe(0);
    const helper = f.helperPath();
    writeFileSync(snapshot, '{');
    const bad = f.run(helper, 'env', snapshot);
    expect(bad.result.status).toBe(1);
    expect(bad.calls).toEqual([]);
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
    writeFileSync(
      snapshot,
      JSON.stringify({
        ...f.pins,
        osv: { ...f.pins.osv, image: `${f.pins.osv.image}\nINJECTED=1` },
      })
    );
    expect(f.run(helper, 'env', snapshot).result.status).toBe(1);
    writeFileSync(
      snapshot,
      JSON.stringify({ ...f.pins, semgrep: { ...f.pins.semgrep, version: '9.9.9' } })
    );
    expect(f.run(helper, 'env', snapshot).result.status).toBe(1);
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
    expect(f.run(helper, 'check', 'pinned-tools.json').result.status).toBe(1);
    expect(existsSync(f.env.CALLS)).toBe(false);
  });

  it('fails closed on cooling, digest, and registry errors without leaking a token', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const snapshot = f.copyMetadata();
    const helper = f.helperPath();
    expect(f.run(helper, 'check', snapshot, 'young').result.stderr).toContain('No stable');
    expect(f.run(helper, 'check', snapshot, 'digest-mismatch').result.status).toBe(1);
    const api = f.run(helper, 'check', snapshot, 'api-fail');
    expect(api.result.status).toBe(1);
    expect(api.calls.at(-1)?.args).toContain('repos/semgrep/semgrep/releases?per_page=100');
    const registry = f.run(helper, 'check', snapshot, 'manifest-fail');
    expect(registry.result.status).toBe(1);
    expect(registry.result.stderr).toContain('curl request failed (exit 7)');
    expect(registry.result.stderr).not.toContain('fixture-bearer-token');
  });

  it('imports the prepared helper without loading metadata or running a CLI', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const helper = f.helperPath();
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(helper).href)})`,
      ],
      { cwd: f.candidateCheckout, env: f.env, encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
    expect(existsSync(f.env.CALLS)).toBe(false);
  });
});
