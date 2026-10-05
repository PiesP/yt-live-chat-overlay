import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const classifier = resolve(import.meta.dirname, '../../../scripts/ci/classify-workflow-changes.sh');

type Scopes = Record<string, boolean>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(cwd: string, path: string, content = 'fixture\n'): void {
  const fullPath = join(cwd, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function commit(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'workflow-classifier-'));
  try {
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.name', 'Classifier Test');
    git(cwd, 'config', 'user.email', 'classifier@example.invalid');
    git(cwd, 'config', 'diff.renames', 'true');
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function classify(cwd: string, event: string, base: string, head: string): Scopes {
  const result = spawnSync('bash', [classifier], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: '',
      EVENT_NAME: event,
      BASE_SHA: base,
      HEAD_SHA: head,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout.trim().split('\n').map((line) => {
      const [scope, enabled] = line.split('=');
      return [scope, enabled === 'true'];
    })
  );
}

function expectSource(scopes: Scopes): void {
  expect(scopes).toMatchObject({
    all: false,
    quality: true,
    unit: true,
    e2e: true,
    build: true,
    duplication: true,
    semgrep: true,
    codeql_javascript: true,
  });
}

function expectDocs(scopes: Scopes): void {
  expect(scopes).toMatchObject({
    all: false,
    quality: false,
    unit: false,
    e2e: false,
    build: false,
    semgrep: true,
    codeql_javascript: false,
  });
}

it.each([
  ['docs/audit-example.ts', 'pull_request'],
  ['test/unit/audit-example.ts', 'push'],
  ['docs/audit-example.ts', 'merge_group'],
])('classifies both sides of a source move to %s for %s', (destination, event) => {
  fixture((cwd) => {
    write(cwd, 'src/audit-example.ts');
    const base = commit(cwd, 'base');
    mkdirSync(dirname(join(cwd, destination)), { recursive: true });
    renameSync(join(cwd, 'src/audit-example.ts'), join(cwd, destination));
    const head = commit(cwd, 'move source');
    expectSource(classify(cwd, event, base, head));
  });
});

it.each([
  ['docs/audit-example.ts', 'src/audit-example.ts'],
  ['test/unit/audit-example.ts', 'src/audit-example.ts'],
  ['src/old-name.ts', 'src/new-name.ts'],
])('classifies rename-only changes from %s to %s', (source, destination) => {
  fixture((cwd) => {
    write(cwd, source);
    const base = commit(cwd, 'base');
    mkdirSync(dirname(join(cwd, destination)), { recursive: true });
    renameSync(join(cwd, source), join(cwd, destination));
    const head = commit(cwd, 'rename');
    expectSource(classify(cwd, 'pull_request', base, head));
  });
});

it('keeps a deleted source path and a filename containing a newline', () => {
  fixture((cwd) => {
    const path = 'src/audit\nexample.ts';
    write(cwd, path);
    const base = commit(cwd, 'base');
    rmSync(join(cwd, path));
    const head = commit(cwd, 'delete source');
    expectSource(classify(cwd, 'push', base, head));
  });
});

it('keeps both paths of a rename with a filename containing a newline', () => {
  fixture((cwd) => {
    const source = 'src/audit\nexample.ts';
    const destination = 'docs/audit\nexample.ts';
    write(cwd, source);
    const base = commit(cwd, 'base');
    mkdirSync(join(cwd, 'docs'));
    renameSync(join(cwd, source), join(cwd, destination));
    const head = commit(cwd, 'move newline source');
    expectSource(classify(cwd, 'pull_request', base, head));
  });
});

it.each([false, true])('classifies a source file type change with docs=%s', (withDocs) => {
  fixture((cwd) => {
    write(cwd, 'src/audit-example.ts');
    write(cwd, 'README.md');
    const base = commit(cwd, 'base');
    rmSync(join(cwd, 'src/audit-example.ts'));
    symlinkSync('../README.md', join(cwd, 'src/audit-example.ts'));
    if (withDocs) write(cwd, 'README.md', 'updated\n');
    const head = commit(cwd, 'change source type');
    expectSource(classify(cwd, 'push', base, head));
  });
});

it('retains documentation-only routing through Git extraction', () => {
  fixture((cwd) => {
    write(cwd, 'README.md');
    const base = commit(cwd, 'base');
    write(cwd, 'README.md', 'updated\n');
    const head = commit(cwd, 'docs');
    expectDocs(classify(cwd, 'pull_request', base, head));
  });
});

it('retains push and PR-like comparison boundaries', () => {
  fixture((cwd) => {
    write(cwd, 'README.md');
    const common = commit(cwd, 'common');
    write(cwd, 'package.json', '{"name":"fixture"}\n');
    const base = commit(cwd, 'base branch dependency change');
    git(cwd, 'checkout', '-q', common);
    write(cwd, 'docs/feature.md');
    const head = commit(cwd, 'feature docs');
    expectDocs(classify(cwd, 'pull_request', base, head));
    expectDocs(classify(cwd, 'merge_group', base, head));
    expect(classify(cwd, 'push', base, head)).toMatchObject({
      quality: true,
      unit: true,
      core: true,
      e2e: true,
      build: true,
      osv: true,
    });
  });
});

it('enables every scope for unknown paths, invalid revisions, Git errors, and empty diffs', () => {
  fixture((cwd) => {
    write(cwd, 'README.md');
    const base = commit(cwd, 'base');
    write(cwd, 'new-config.unknown');
    const unknown = commit(cwd, 'unknown path');
    const unrelated = git(cwd, 'commit-tree', git(cwd, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated');
    for (const scopes of [
      classify(cwd, 'push', base, unknown),
      classify(cwd, 'push', '0'.repeat(40), unknown),
      classify(cwd, 'pull_request', '1'.repeat(40), unknown),
      classify(cwd, 'merge_group', unrelated, unknown),
      classify(cwd, 'push', base, base),
      classify(cwd, 'schedule', base, base),
      classify(cwd, 'unknown', base, base),
    ]) {
      expect(Object.values(scopes)).not.toContain(false);
    }
  });
});
