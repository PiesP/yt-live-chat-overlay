import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// These are small unit doubles. Source-bound interruption acceptance uses installed Stryker separately.
const sourceLauncher = fileURLToPath(new URL('./mutation-workspace.ts', import.meta.url));
const owner = mkdtempSync(join(tmpdir(), 'ytlc-mutation-boundary-'));
const maintainer = join(owner, 'maintainer');
const coreOrigin = join(owner, 'core-origin');
const runnerTemp = join(owner, 'runner-temp');
mkdirSync(runnerTemp);
after(() => rmSync(owner, { recursive: true, force: true }));

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(
    cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    message
  );
}

git(owner, 'init', '-q', coreOrigin);
write(join(coreOrigin, 'package.json'), '{"name":"@piesp/browser-core","version":"0.0.0"}\n');
write(join(coreOrigin, 'src/index.js'), 'export const core = 1;\n');
commit(coreOrigin, 'core fixture');

git(owner, 'init', '-q', maintainer);
write(join(maintainer, '.gitignore'), 'node_modules/\nreports/\n.stryker-tmp*/\n');
write(
  join(maintainer, 'package.json'),
  '{"name":"yt-live-chat-overlay","version":"0.0.0","private":true,"type":"module","packageManager":"pnpm@11.26.0","volta":{"node":"26.9.0","pnpm":"11.26.0"},"devDependencies":{"@stryker-mutator/core":"10.0.0","@stryker-mutator/vitest-runner":"10.0.0","vitest":"4.1.11"}}\n'
);
write(
  join(maintainer, 'pnpm-lock.yaml'),
  `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    devDependencies:
      '@stryker-mutator/core':
        specifier: 10.0.0
        version: 10.0.0
      '@stryker-mutator/vitest-runner':
        specifier: 10.0.0
        version: 10.0.0
      vitest:
        specifier: 4.1.11
        version: 4.1.11
packages:
  '@stryker-mutator/core@10.0.0':
    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}
  '@stryker-mutator/vitest-runner@10.0.0':
    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}
  'vitest@4.1.11':
    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}
snapshots:
  '@stryker-mutator/core@10.0.0': {}
  '@stryker-mutator/vitest-runner@10.0.0': {}
  'vitest@4.1.11': {}
`
);
write(join(maintainer, 'stryker.conf.json'), '{"inPlace":true,"mutate":["src/committed.txt"]}\n');
write(
  join(maintainer, 'stryker.conf.fast.json'),
  '{"inPlace":true,"mutate":["src/committed.txt"]}\n'
);
write(
  join(maintainer, 'stryker.conf.renderer.json'),
  '{"inPlace":true,"mutate":["src/committed.txt:1-2"]}\n'
);
write(join(maintainer, 'src/committed.txt'), 'committed source\n');
write(join(maintainer, 'test/example.test.ts'), 'export const fixture = true;\n');
mkdirSync(join(maintainer, 'scripts/ci'), { recursive: true });
copyFileSync(sourceLauncher, join(maintainer, 'scripts/ci/mutation-workspace.ts'));
git(
  maintainer,
  '-c',
  'protocol.file.allow=always',
  'submodule',
  'add',
  `file://${coreOrigin}`,
  'packages/core'
);
commit(maintainer, 'protected committed source');
const selected = git(maintainer, 'rev-parse', 'HEAD');

write(join(maintainer, 'src/staged.txt'), 'staged private change\n');
git(maintainer, 'add', 'src/staged.txt');
write(join(maintainer, 'src/committed.txt'), 'unstaged private change\n');
write(join(maintainer, 'private-untracked.txt'), 'untracked private change\n');
write(join(maintainer, 'packages/core/src/index.js'), 'export const core = "dirty private";\n');

function protectedState(): Record<string, string> {
  const names = [
    'src/committed.txt',
    'src/staged.txt',
    'private-untracked.txt',
    'packages/core/src/index.js',
    '.git/index',
    '.git/modules/packages/core/index',
  ];
  const state = Object.fromEntries(
    names.map((name) => [name, readFileSync(join(maintainer, name)).toString('hex')])
  );
  state.refs = git(maintainer, 'for-each-ref', '--format=%(refname) %(objectname)');
  state.head = git(maintainer, 'rev-parse', 'HEAD');
  state.indexEntries = git(maintainer, 'ls-files', '--stage');
  state.status = git(maintainer, 'status', '--porcelain=v1', '--untracked-files=all');
  state.coreHead = git(join(maintainer, 'packages/core'), 'rev-parse', 'HEAD');
  state.coreStatus = git(join(maintainer, 'packages/core'), 'status', '--porcelain=v1');
  return state;
}

const original = protectedState();
function maintainerUnchanged(): void {
  assert.deepEqual(protectedState(), original);
}

const fakeStryker = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_MUTATION_MODE === 'hold'
  ? '.git/ytlc-mutation/run/fake-argv.json' : 'fake-argv.json', JSON.stringify(args));
if (process.env.FAKE_MUTATION_MODE === 'fail') process.exit(7);
if (process.env.FAKE_MUTATION_MODE === 'hold') {
  writeFileSync('.git/ytlc-mutation/run/fake-started', 'started');
  const deadline = Date.now() + 10000;
  while (!existsSync('fake-release') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  if (!existsSync('fake-release')) process.exit(8);
}
if (['stryker.conf.json', 'stryker.conf.fast.json', 'stryker.conf.renderer.json'].includes(args[1]) && !args.includes('--dryRunOnly')) {
  mkdirSync(join('reports', 'mutation'), { recursive: true });
  const mode = process.env.FAKE_MUTATION_MODE;
  const name = args[1] === 'stryker.conf.json' ? 'mutation' : args[1] === 'stryker.conf.fast.json' ? 'fast' : 'renderer';
  if (mode !== 'json-missing') writeFileSync(join('reports', 'mutation', name + '.json'), process.env.FAKE_MUTATION_REPORT_JSON ?? (mode === 'malformed'
    ? '{bad'
    : JSON.stringify({ files: { 'src/committed.txt': { mutants: mode === 'empty' ? [] : [mode === 'missing-status' ? {} : { status: mode === 'pending' ? 'Pending' : 'Killed' }] } } })));
  if (process.env.FAKE_MUTATION_OTHER_REPORT) {
    writeFileSync(join('reports', 'mutation', name === 'fast' ? 'renderer.json' : 'fast.json'), process.env.FAKE_MUTATION_OTHER_REPORT);
  }
  if (name === 'fast' && mode !== 'html-missing') {
    if (mode === 'html-read-error') mkdirSync(join('reports', 'mutation', 'mutation.html'));
    else writeFileSync(join('reports', 'mutation', 'mutation.html'), mode === 'html-empty' ? '' : '<html>fixture</html>');
  }
  if (mode === 'dirty-source') writeFileSync('src/committed.txt', 'unrestored mutation');
}
`;

function clone(): string {
  const execution = join(owner, `execution-${randomUUID()}`);
  git(owner, 'clone', '--no-local', '--no-hardlinks', '--no-checkout', maintainer, execution);
  git(execution, '-c', 'advice.detachedHead=false', 'checkout', '--detach', selected);
  git(
    execution,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive'
  );
  const installedCore = join(execution, 'node_modules/@piesp/browser-core');
  for (const name of ['package.json', 'src/index.js']) {
    const destination = join(installedCore, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(execution, 'packages/core', name), destination);
  }
  const stryker = join(execution, 'node_modules/@stryker-mutator/core');
  write(join(stryker, 'package.json'), '{"name":"@stryker-mutator/core","version":"10.0.0"}\n');
  write(join(stryker, 'bin/stryker.js'), fakeStryker);
  write(
    join(execution, 'node_modules/@stryker-mutator/vitest-runner/package.json'),
    '{"name":"@stryker-mutator/vitest-runner","version":"10.0.0"}\n'
  );
  write(
    join(execution, 'node_modules/vitest/package.json'),
    '{"name":"vitest","version":"4.1.11"}\n'
  );
  mkdirSync(join(execution, 'node_modules/.pnpm'), { recursive: true });
  copyFileSync(join(execution, 'pnpm-lock.yaml'), join(execution, 'node_modules/.pnpm/lock.yaml'));
  return execution;
}

function invoke(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/ci/mutation-workspace.ts', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...extraEnv },
    }
  );
}

function prepared(): string {
  const execution = clone();
  const result = invoke(execution, ['prepare', maintainer, selected]);
  assert.equal(result.status, 0, result.stderr);
  return execution;
}

function runRecord(execution: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(execution, '.git/ytlc-mutation/run/result.json'), 'utf8')
  ) as Record<string, unknown>;
}

function snapshotOutcome(label: string, execution: string, exit: number | null): void {
  const destination = process.env.MUTATION_TEST_EVIDENCE_DIR;
  if (!destination) return;
  const reportDir = join(execution, 'reports/mutation');
  const reports = existsSync(reportDir)
    ? Object.fromEntries(
        readdirSync(reportDir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => [name, readFileSync(join(reportDir, name), 'utf8')])
      )
    : {};
  const receipt = runRecord(execution);
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    join(destination, `${label}.json`),
    `${JSON.stringify(
      {
        label,
        exit,
        receipt: {
          status: receipt.status,
          exitCode: receipt.exitCode,
          child: receipt.child,
          restored: receipt.restored,
          reportsComplete: receipt.reportsComplete,
        },
        reports,
        childLog: readFileSync(join(execution, '.git/ytlc-mutation/run/child.log'), 'utf8'),
      },
      null,
      2
    )}\n`
  );
}

test('all ordinary maintainer commands refuse before instrumentation without changing protected state', () => {
  for (const profile of ['full', 'fast', 'renderer']) {
    const result = invoke(maintainer, ['run', profile], { CI: 'true' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refused before instrumentation/i);
    assert.equal(existsSync(join(maintainer, '.git/ytlc-mutation')), false);
    assert.equal(existsSync(join(maintainer, 'fake-argv.json')), false);
    maintainerUnchanged();
  }
});

test('explicit committed preparation admits an independent clone without copying private edits', () => {
  const execution = prepared();
  assert.equal(realpathSync(execution) === realpathSync(maintainer), false);
  assert.equal(git(execution, 'remote', 'get-url', 'origin'), realpathSync(maintainer));
  assert.equal(readFileSync(join(execution, 'src/committed.txt'), 'utf8'), 'committed source\n');
  assert.equal(existsSync(join(execution, 'src/staged.txt')), false);
  assert.equal(existsSync(join(execution, 'private-untracked.txt')), false);
  assert.equal(
    readFileSync(join(execution, 'packages/core/src/index.js'), 'utf8'),
    'export const core = 1;\n'
  );
  assert.equal(
    realpathSync(git(join(execution, 'packages/core'), 'rev-parse', '--absolute-git-dir')),
    join(execution, '.git/modules/packages/core')
  );
  assert.equal(
    readFileSync(join(execution, 'node_modules/@piesp/browser-core/src/index.js'), 'utf8'),
    'export const core = 1;\n'
  );
  assert.equal(invoke(execution, ['prepare', maintainer, selected]).status, 2);
  maintainerUnchanged();
});

test('local admission keeps clone origin bound to the named source during preparation and execution', () => {
  const swapped = clone();
  git(swapped, 'remote', 'set-url', 'origin', 'https://github.com/PiesP/yt-live-chat-overlay.git');
  assert.notEqual(invoke(swapped, ['prepare', maintainer, selected]).status, 0);
  assert.equal(existsSync(join(swapped, '.git/ytlc-mutation')), false);

  const execution = prepared();
  const other = clone();
  const recordPath = join(execution, '.git/ytlc-mutation/prepared.json');
  const changed = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
  changed.source = other;
  writeFileSync(recordPath, `${JSON.stringify(changed)}\n`);
  assert.notEqual(invoke(execution, ['run', 'fast']).status, 0);
  assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run')), false);
  assert.equal(existsSync(join(execution, 'fake-argv.json')), false);

  const originChanged = prepared();
  git(
    originChanged,
    'remote',
    'set-url',
    'origin',
    'https://github.com/PiesP/yt-live-chat-overlay.git'
  );
  assert.notEqual(invoke(originChanged, ['run', 'fast']).status, 0);
  assert.equal(existsSync(join(originChanged, '.git/ytlc-mutation/run')), false);
  assert.equal(existsSync(join(originChanged, 'fake-argv.json')), false);
  maintainerUnchanged();
});

test('core common object storage outside the clone is refused before preparation', () => {
  const execution = clone();
  const coreDir = realpathSync(
    git(join(execution, 'packages/core'), 'rev-parse', '--absolute-git-dir')
  );
  const externalCommon = realpathSync(join(coreOrigin, '.git'));
  write(join(coreDir, 'commondir'), `${externalCommon}\n`);
  assert.equal(
    realpathSync(git(join(execution, 'packages/core'), 'rev-parse', '--git-common-dir')),
    externalCommon
  );
  const result = invoke(execution, ['prepare', maintainer, selected]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Core and object storage must belong/);
  assert.equal(existsSync(join(execution, '.git/ytlc-mutation')), false);
  maintainerUnchanged();
});

test('Git worktree routing outside either execution root is refused before preparation', () => {
  for (const scope of ['root', 'core'] as const) {
    const execution = clone();
    const external = clone();
    const location = scope === 'root' ? execution : join(execution, 'packages/core');
    const target = scope === 'root' ? external : join(external, 'packages/core');
    git(location, 'config', 'core.worktree', target);
    assert.equal(realpathSync(git(location, 'rev-parse', '--show-toplevel')), target);

    const result = invoke(execution, ['prepare', maintainer, selected]);
    assert.notEqual(result.status, 0, `${scope}: ${result.stderr}`);
    assert.match(result.stderr, /Git worktree|execution checkout|top-level/i);
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation')), false);
    assert.equal(existsSync(join(execution, 'fake-argv.json')), false);
    maintainerUnchanged();
  }
});

test('a nonregular installed core file is refused without an empty-content fallback', () => {
  const execution = clone();
  const installedFile = join(execution, 'node_modules/@piesp/browser-core/src/index.js');
  rmSync(installedFile);
  mkdirSync(installedFile);
  const result = invoke(execution, ['prepare', maintainer, selected]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed file:packages\/core differs|regular file/i);
  assert.equal(existsSync(join(execution, '.git/ytlc-mutation')), false);
  assert.equal(existsSync(join(execution, 'fake-argv.json')), false);
  maintainerUnchanged();
});

test('stale installed lock and post-preparation tool swaps refuse before instrumentation', () => {
  const stale = clone();
  write(join(stale, 'node_modules/.pnpm/lock.yaml'), 'stale install\n');
  assert.match(
    invoke(stale, ['prepare', maintainer, selected]).stderr,
    /Installed pnpm lock differs/
  );
  assert.equal(existsSync(join(stale, '.git/ytlc-mutation')), false);

  const wrongTool = clone();
  write(
    join(wrongTool, 'node_modules/@stryker-mutator/vitest-runner/package.json'),
    '{"name":"@stryker-mutator/vitest-runner","version":"9.9.9"}\n'
  );
  assert.match(
    invoke(wrongTool, ['prepare', maintainer, selected]).stderr,
    /Installed mutation tool differs from the selected lock/
  );
  assert.equal(existsSync(join(wrongTool, '.git/ytlc-mutation')), false);

  for (const path of [
    'node_modules/.pnpm/lock.yaml',
    'node_modules/@stryker-mutator/core/package.json',
    'node_modules/@stryker-mutator/vitest-runner/package.json',
    'node_modules/vitest/package.json',
  ]) {
    const execution = prepared();
    write(join(execution, path), 'changed after preparation\n');
    assert.notEqual(invoke(execution, ['run', 'fast']).status, 0, path);
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run')), false);
  }
  maintainerUnchanged();
});

test('fresh checkout rejects untracked or ignored inputs outside installed dependencies', () => {
  for (const name of [
    'src/untracked.ts',
    'test/unit/untracked.test.ts',
    'vitest.config.ts',
    'reports/mutation/stale.txt',
    '.stryker-tmp-stale/backup.txt',
    '.deep-check-cache/mutation.json',
  ]) {
    const execution = clone();
    write(join(execution, name), 'unexpected source or report\n');
    assert.notEqual(invoke(execution, ['prepare', maintainer, selected]).status, 0, name);
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation')), false, name);
  }
  const preparedExecution = prepared();
  write(join(preparedExecution, 'src/untracked.ts'), 'untracked after preparation\n');
  assert.notEqual(invoke(preparedExecution, ['run', 'fast']).status, 0);
  assert.equal(existsSync(join(preparedExecution, '.git/ytlc-mutation/run')), false);
  assert.equal(existsSync(join(preparedExecution, 'fake-argv.json')), false);
  maintainerUnchanged();
});

test('wrong commit, copied record, path escape, and shared core dependency are refused', () => {
  const wrong = clone();
  assert.equal(invoke(wrong, ['prepare', maintainer, 'a'.repeat(40)]).status, 2);
  assert.equal(existsSync(join(wrong, '.git/ytlc-mutation')), false);

  const first = prepared();
  const second = clone();
  mkdirSync(join(second, '.git/ytlc-mutation'));
  copyFileSync(
    join(first, '.git/ytlc-mutation/prepared.json'),
    join(second, '.git/ytlc-mutation/prepared.json')
  );
  assert.match(invoke(second, ['run', 'fast']).stderr, /Mismatched preparation record/);
  assert.equal(existsSync(join(second, 'fake-argv.json')), false);

  const escaped = clone();
  symlinkSync(maintainer, join(escaped, 'reports'));
  assert.notEqual(invoke(escaped, ['prepare', maintainer, selected]).status, 0);
  assert.equal(existsSync(join(escaped, '.git/ytlc-mutation')), false);

  const shared = clone();
  rmSync(join(shared, 'node_modules/@piesp/browser-core'), { recursive: true });
  symlinkSync(join(maintainer, 'packages/core'), join(shared, 'node_modules/@piesp/browser-core'));
  assert.notEqual(invoke(shared, ['prepare', maintainer, selected]).status, 0);
  assert.equal(existsSync(join(shared, '.git/ytlc-mutation')), false);
  maintainerUnchanged();
});

test('an empty shared writable directory is refused by directory identity', () => {
  const execution = clone();
  const shared = join(execution, 'empty-writable');
  const alias = join(maintainer, 'empty-execution-alias');
  mkdirSync(shared);
  symlinkSync(shared, alias);
  try {
    const result = invoke(execution, ['prepare', maintainer, selected]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shares files or dependencies/);
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation')), false);
    assert.equal(existsSync(alias), true);
  } finally {
    rmSync(alias);
  }
  maintainerUnchanged();
});

test('an empty dependency bind mount into the maintainer checkout is refused', (context) => {
  const execution = clone();
  const source = join(maintainer, 'node_modules/.vite');
  const target = join(execution, 'node_modules/.vite');
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  const result = spawnSync(
    'unshare',
    [
      '--user',
      '--map-root-user',
      '--mount',
      '--',
      'sh',
      '-c',
      'mount --make-rprivate / && mount --bind "$1" "$2" && exec "$3" --experimental-strip-types scripts/ci/mutation-workspace.ts prepare "$4" "$5"',
      'sh',
      source,
      target,
      process.execPath,
      maintainer,
      selected,
    ],
    { cwd: execution, encoding: 'utf8', timeout: 15_000 }
  );
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    context.skip('unshare is not installed');
    return;
  }
  if (/Operation not permitted|Permission denied/.test(result.stderr) && result.status !== 2) {
    context.skip('user mount namespace is unavailable');
    return;
  }
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /shares files or dependencies/);
  assert.equal(existsSync(join(execution, '.git/ytlc-mutation')), false);
  assert.deepEqual(readdirSync(source), []);
  maintainerUnchanged();
});

test('full, fast and renderer profiles forward supported arguments and retain one analysis claim', () => {
  const full = prepared();
  const fullResult = invoke(full, [
    'run',
    'full',
    '--dryRunOnly',
    '-c',
    '2',
    '--logLevel=debug',
    '--mutate',
    'src/committed.txt,!src/committed.txt,src/committed.txt:1-2',
    '--testFiles',
    'test/**/*.test.ts',
  ]);
  assert.equal(fullResult.status, 0, fullResult.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(full, 'fake-argv.json'), 'utf8')), [
    'run',
    'stryker.conf.json',
    '--reporters=progress,json',
    '--dryRunOnly',
    '-c',
    '2',
    '--logLevel',
    'debug',
    '--mutate',
    'src/committed.txt,!src/committed.txt,src/committed.txt:1-2',
    '--testFiles',
    'test/**/*.test.ts',
  ]);
  assert.equal(runRecord(full).status, 'dry-run-only');
  assert.notEqual(invoke(full, ['run', 'fast']).status, 0);

  const fullAnalysis = prepared();
  assert.equal(invoke(fullAnalysis, ['run', 'full']).status, 0);
  assert.equal(runRecord(fullAnalysis).status, 'completed');
  assert.equal(existsSync(join(fullAnalysis, 'reports/mutation/mutation.json')), true);

  const fast = prepared();
  assert.equal(invoke(fast, ['run', 'fast']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(fast, 'fake-argv.json'), 'utf8')), [
    'run',
    'stryker.conf.fast.json',
  ]);
  assert.equal(runRecord(fast).status, 'completed');
  assert.equal(existsSync(join(fast, 'reports/mutation/fast.json')), true);
  const renderer = prepared();
  assert.equal(invoke(renderer, ['run', 'renderer']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(renderer, 'fake-argv.json'), 'utf8')), [
    'run',
    'stryker.conf.renderer.json',
  ]);
  assert.equal(runRecord(renderer).status, 'completed');
  assert.equal(existsSync(join(renderer, 'reports/mutation/renderer.json')), true);
  maintainerUnchanged();
});

test('unsafe output and path arguments refuse before a run claim or fake child', () => {
  const execution = prepared();
  for (const args of [
    ['--tempDirName', '../../maintainer'],
    ['--reporters', 'html'],
    ['--mutate', '../maintainer/src/*.ts'],
    ['--mutate', join(maintainer, 'src/committed.txt')],
    ['--mutate', 'src/{private,public}.ts'],
    ['--mutate', 'src/[a-z].ts'],
    ['--mutate', 'src/missing.ts'],
    ['--mutate', 'src/*.txt,!src/committed.txt'],
    ['--testFiles', 'test/**/../private.test.ts'],
    ['--testFiles', 'test/missing.test.ts'],
    ['--testFiles', 'test/**/*.test.ts,!test/example.test.ts'],
    ['--testFiles', 'test/example.test.ts:1-2'],
    ['--testFiles', 'node_modules/.vite/hidden.test.ts'],
  ]) {
    const result = invoke(execution, ['run', 'fast', ...args]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run')), false);
    assert.equal(existsSync(join(execution, 'fake-argv.json')), false);
  }
  maintainerUnchanged();
});

test('child failure and malformed or empty reports never create successful receipts', () => {
  for (const mode of ['fail', 'malformed', 'empty']) {
    const execution = prepared();
    const result = invoke(execution, ['run', 'fast'], { FAKE_MUTATION_MODE: mode });
    assert.notEqual(result.status, 0, mode);
    const receipt = runRecord(execution);
    assert.notEqual(receipt.status, 'completed', mode);
    assert.equal(receipt.exitCode, mode === 'fail' ? 7 : 1);
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run/start.json')), true);
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run/child.log')), true);
    maintainerUnchanged();
  }
});

test('full profile requires a nonempty terminal JSON report alongside progress', () => {
  for (const mode of ['malformed', 'empty', 'pending', 'missing-status']) {
    const execution = prepared();
    const result = invoke(execution, ['run', 'full'], { FAKE_MUTATION_MODE: mode });
    assert.notEqual(result.status, 0, mode);
    assert.equal(runRecord(execution).status, 'reports-incomplete');
    maintainerUnchanged();
  }
});

test('all profiles reject missing and non-array file mutants and array statuses', () => {
  const valid = { mutants: [{ status: 'Killed' }] };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing-last', { 'src/ok.ts': valid, 'src/bad.ts': {} }],
    ['missing-first', { 'src/bad.ts': {}, 'src/ok.ts': valid }],
    ['non-array-last', { 'src/ok.ts': valid, 'src/bad.ts': { mutants: {} } }],
    ['non-array-first', { 'src/bad.ts': { mutants: {} }, 'src/ok.ts': valid }],
    ['array-status', { 'src/bad.ts': { mutants: [{ status: ['Killed'] }] } }],
  ];
  const observed: string[] = [];
  for (const profile of ['full', 'fast', 'renderer']) {
    for (const [name, files] of cases) {
      const execution = prepared();
      const label = `${profile}-${name}`;
      const result = invoke(execution, ['run', profile], {
        FAKE_MUTATION_REPORT_JSON: JSON.stringify({ files }),
      });
      snapshotOutcome(label, execution, result.status);
      const receipt = runRecord(execution);
      if (
        result.status !== 1 ||
        receipt.status !== 'reports-incomplete' ||
        receipt.reportsComplete !== false ||
        receipt.exitCode !== 1 ||
        receipt.restored !== true ||
        (receipt.child as { code?: number }).code !== 0
      ) {
        observed.push(`${label}: exit=${result.status}, status=${receipt.status}`);
      }
      maintainerUnchanged();
    }
  }
  assert.deepEqual(observed, []);
});

test('status and record shapes require every mutant to be a terminal object with a string status', () => {
  const terminal = { mutants: [{ status: 'Killed' }] };
  const invalid: Array<[string, unknown]> = [
    ['status-missing', {}],
    ['status-null', { status: null }],
    ['status-object', { status: { value: 'Killed' } }],
    ['status-number', { status: 1 }],
    ['status-boolean', { status: true }],
    ['status-pending', { status: 'Pending' }],
    ['status-unknown', { status: 'Unknown' }],
    ['mutant-null', null],
    ['mutant-array', [{ status: 'Killed' }]],
  ];
  for (const [name, mutant] of invalid) {
    const execution = prepared();
    const result = invoke(execution, ['run', 'fast'], {
      FAKE_MUTATION_REPORT_JSON: JSON.stringify({
        files: { 'src/ok.ts': terminal, 'src/bad.ts': { mutants: [mutant] } },
      }),
    });
    const receipt = runRecord(execution);
    assert.equal(result.status, 1, name);
    assert.equal(receipt.status, 'reports-incomplete', name);
    assert.equal(receipt.reportsComplete, false, name);
    assert.equal(receipt.exitCode, 1, name);
    maintainerUnchanged();
  }
});

test('empty inventories and malformed file records cannot complete, but terminal statuses and empty files can', () => {
  const invalid: Array<[string, unknown]> = [
    ['files-missing', {}],
    ['files-null', { files: null }],
    ['files-array', { files: [] }],
    ['files-empty', { files: {} }],
    ['all-empty', { files: { 'src/a.ts': { mutants: [] }, 'src/b.ts': { mutants: [] } } }],
    ['file-null', { files: { 'src/a.ts': { mutants: [{ status: 'Killed' }] }, 'src/b.ts': null } }],
    ['file-array', { files: { 'src/a.ts': [{ mutants: [] }] } }],
  ];
  for (const [name, report] of invalid) {
    const execution = prepared();
    const result = invoke(execution, ['run', 'renderer'], {
      FAKE_MUTATION_REPORT_JSON: JSON.stringify(report),
    });
    assert.equal(result.status, 1, name);
    assert.equal(runRecord(execution).status, 'reports-incomplete', name);
    maintainerUnchanged();
  }
  for (const profile of ['full', 'fast', 'renderer']) {
    const execution = prepared();
    const statuses = [
      'Killed',
      'Survived',
      'NoCoverage',
      'Timeout',
      'Ignored',
      'CompileError',
      'RuntimeError',
    ];
    const result = invoke(execution, ['run', profile], {
      FAKE_MUTATION_REPORT_JSON: JSON.stringify({
        files: {
          'src/empty.ts': { mutants: [] },
          'src/populated.ts': { mutants: statuses.map((status) => ({ status })) },
        },
      }),
    });
    assert.equal(result.status, 0, `${profile}: ${result.stderr}`);
    assert.equal(runRecord(execution).status, 'completed', profile);
    assert.equal(runRecord(execution).reportsComplete, true, profile);
    maintainerUnchanged();
  }
});

test('each profile reads only its selected JSON and fast requires readable nonempty HTML', () => {
  const valid = JSON.stringify({ files: { 'src/ok.ts': { mutants: [{ status: 'Killed' }] } } });
  for (const profile of ['full', 'fast', 'renderer']) {
    for (const mode of ['json-missing', 'malformed']) {
      const execution = prepared();
      const result = invoke(execution, ['run', profile], {
        FAKE_MUTATION_MODE: mode,
        FAKE_MUTATION_OTHER_REPORT: valid,
      });
      assert.equal(result.status, 1, `${profile}/${mode}`);
      assert.equal(runRecord(execution).status, 'reports-incomplete', `${profile}/${mode}`);
      assert.equal(runRecord(execution).reportsComplete, false, `${profile}/${mode}`);
      maintainerUnchanged();
    }
  }
  for (const mode of ['html-missing', 'html-empty', 'html-read-error']) {
    const execution = prepared();
    const result = invoke(execution, ['run', 'fast'], { FAKE_MUTATION_MODE: mode });
    assert.equal(result.status, 1, mode);
    assert.equal(runRecord(execution).reportsComplete, false, mode);
    assert.equal(runRecord(execution).status, 'reports-incomplete', mode);
    maintainerUnchanged();
  }
  for (const profile of ['full', 'renderer']) {
    const execution = prepared();
    assert.equal(
      invoke(execution, ['run', profile], { FAKE_MUTATION_MODE: 'html-missing' }).status,
      0
    );
    assert.equal(runRecord(execution).status, 'completed');
    maintainerUnchanged();
  }
});

test('dry run, child failure, and uncertain restoration retain their outcome precedence', () => {
  const dry = prepared();
  assert.equal(invoke(dry, ['run', 'fast', '--dryRunOnly']).status, 0);
  assert.equal(runRecord(dry).status, 'dry-run-only');
  assert.equal(runRecord(dry).reportsComplete, null);
  const failed = prepared();
  assert.equal(invoke(failed, ['run', 'renderer'], { FAKE_MUTATION_MODE: 'fail' }).status, 7);
  assert.equal(runRecord(failed).status, 'child-failed');
  assert.equal(runRecord(failed).exitCode, 7);
  assert.equal(runRecord(failed).reportsComplete, false);
  const dirty = prepared();
  assert.equal(invoke(dirty, ['run', 'full'], { FAKE_MUTATION_MODE: 'dirty-source' }).status, 1);
  assert.equal(runRecord(dirty).status, 'restoration-unverified');
  assert.equal(runRecord(dirty).exitCode, 1);
  assert.equal(runRecord(dirty).reportsComplete, true);
  assert.equal(runRecord(dirty).restored, false);
  maintainerUnchanged();
});

test('an active run owns its single-use claim and a second run refuses', async () => {
  const execution = prepared();
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'scripts/ci/mutation-workspace.ts', 'run', 'fast'],
    {
      cwd: execution,
      env: { ...process.env, FAKE_MUTATION_MODE: 'hold' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const completion = new Promise<number | null>((done) => child.once('close', done));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    const deadline = Date.now() + 5000;
    while (
      !existsSync(join(execution, '.git/ytlc-mutation/run/fake-started')) &&
      Date.now() < deadline
    ) {
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run/fake-started')), true, stderr);
    assert.match(invoke(execution, ['run', 'fast']).stderr, /already claimed/);
  } finally {
    write(join(execution, 'fake-release'), 'release');
    const exit = await completion;
    assert.equal(exit, 0, stderr);
  }
  assert.equal(runRecord(execution).status, 'completed');
  maintainerUnchanged();
});

test('whole launcher process-group SIGINT preserves protected state and writes an interrupted receipt', async () => {
  const execution = prepared();
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'scripts/ci/mutation-workspace.ts', 'run', 'fast'],
    {
      cwd: execution,
      env: { ...process.env, FAKE_MUTATION_MODE: 'hold' },
      stdio: 'ignore',
      detached: true,
    }
  );
  const completion = new Promise<number | null>((done) => child.once('close', done));
  const started = join(execution, '.git/ytlc-mutation/run/fake-started');
  const deadline = Date.now() + 5000;
  while (!existsSync(started) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(existsSync(started), true);
  assert.ok(child.pid);
  process.kill(-child.pid, 'SIGINT');
  assert.equal(await completion, 130);
  assert.equal(runRecord(execution).status, 'interrupted');
  assert.equal(runRecord(execution).exitCode, 130);
  assert.equal(runRecord(execution).reportsComplete, false);
  assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run/child.log')), true);
  maintainerUnchanged();
});

test('forced launcher termination retains startup evidence without a false completion receipt', async () => {
  const execution = prepared();
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'scripts/ci/mutation-workspace.ts', 'run', 'fast'],
    {
      cwd: execution,
      env: { ...process.env, FAKE_MUTATION_MODE: 'hold' },
      stdio: 'ignore',
      detached: true,
    }
  );
  const completion = new Promise<number | null>((done) => child.once('close', done));
  const runDir = join(execution, '.git/ytlc-mutation/run');
  const deadline = Date.now() + 5000;
  while (!existsSync(join(runDir, 'fake-started')) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(existsSync(join(runDir, 'fake-started')), true);
  const childRecord = JSON.parse(readFileSync(join(runDir, 'child.json'), 'utf8')) as {
    processGroup: number;
  };
  assert.ok(child.pid);
  try {
    process.kill(child.pid, 'SIGKILL');
    await completion;
  } finally {
    try {
      process.kill(-childRecord.processGroup, 'SIGKILL');
    } catch {
      // The fake child may already have ended.
    }
  }
  assert.equal(existsSync(join(runDir, 'start.json')), true);
  assert.equal(existsSync(join(runDir, 'child.log')), true);
  assert.equal(existsSync(join(runDir, 'result.json')), false);
  maintainerUnchanged();
});

function hostedEnv(
  execution: string,
  commit = selected,
  workflow: 'release' | 'deep-checks' = 'release',
  job = workflow === 'release' ? 'mutation' : 'mutation-fast'
): Record<string, string> {
  return {
    MUTATION_WORKSPACE_CONTRACT: 'github-job-v1',
    MUTATION_SOURCE_SHA: commit,
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'PiesP/yt-live-chat-overlay',
    GITHUB_JOB: job,
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: `PiesP/yt-live-chat-overlay/.github/workflows/${workflow}.yaml@refs/heads/master`,
    GITHUB_WORKSPACE: execution,
    RUNNER_TEMP: runnerTemp,
    GITHUB_SHA: workflow === 'deep-checks' ? commit : 'f'.repeat(40),
  };
}

test('Deep admits only its restored success-marker path before a fresh mutation', () => {
  const execution = clone();
  const marker = join(execution, '.deep-check-cache/mutation-fast.json');
  write(marker, '{"result":"previous successful analysis"}\n');
  const env = hostedEnv(execution, selected, 'deep-checks');
  assert.equal(invoke(execution, ['prepare-hosted'], env).status, 0);
  assert.equal(invoke(execution, ['run', 'fast'], env).status, 0);
  assert.equal(runRecord(execution).status, 'completed');
  assert.equal(readFileSync(marker, 'utf8'), '{"result":"previous successful analysis"}\n');

  const extra = clone();
  write(join(extra, '.deep-check-cache/mutation-fast.json'), '{}\n');
  write(join(extra, '.deep-check-cache/other.json'), '{}\n');
  assert.notEqual(
    invoke(extra, ['prepare-hosted'], hostedEnv(extra, selected, 'deep-checks')).status,
    0
  );
  assert.equal(existsSync(join(extra, '.git/ytlc-mutation')), false);

  const release = clone();
  write(join(release, '.deep-check-cache/mutation-fast.json'), '{}\n');
  assert.notEqual(invoke(release, ['prepare-hosted'], hostedEnv(release)).status, 0);
  assert.equal(existsSync(join(release, '.git/ytlc-mutation')), false);
  maintainerUnchanged();
});

test('renderer Deep job admits its profile and rejects a fast substitution', () => {
  const execution = clone();
  const marker = join(execution, '.deep-check-cache/mutation-renderer.json');
  write(marker, '{"result":"prior renderer analysis"}\n');
  const env = hostedEnv(execution, selected, 'deep-checks', 'mutation-renderer');
  assert.equal(invoke(execution, ['prepare-hosted'], env).status, 0);
  assert.notEqual(invoke(execution, ['run', 'fast'], env).status, 0);
  assert.equal(existsSync(join(execution, '.git/ytlc-mutation/run')), false);
  assert.equal(invoke(execution, ['run', 'renderer'], env).status, 0);
  assert.equal(runRecord(execution).status, 'completed');
  assert.equal(readFileSync(marker, 'utf8'), '{"result":"prior renderer analysis"}\n');
  maintainerUnchanged();
});

test('hosted admission binds verified release commit independently of workflow SHA', () => {
  const execution = clone();
  const env = hostedEnv(execution);
  assert.equal(invoke(execution, ['prepare-hosted'], env).status, 0);
  assert.notEqual(invoke(execution, ['run', 'fast', '--dryRunOnly'], env).status, 0);
  assert.equal(invoke(execution, ['run', 'fast'], env).status, 0);
  assert.equal(runRecord(execution).status, 'completed');
  maintainerUnchanged();
});

test('CI=true alone and wrong hosted source cannot prepare a checkout', () => {
  const bare = clone();
  assert.notEqual(invoke(bare, ['prepare-hosted'], { CI: 'true' }).status, 0);
  assert.equal(existsSync(join(bare, '.git/ytlc-mutation')), false);
  const wrong = clone();
  assert.notEqual(invoke(wrong, ['prepare-hosted'], hostedEnv(wrong, 'a'.repeat(40))).status, 0);
  assert.equal(existsSync(join(wrong, '.git/ytlc-mutation')), false);
  maintainerUnchanged();
});
