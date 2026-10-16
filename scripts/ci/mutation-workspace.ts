import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  globSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const metadata = join(root, '.git/ytlc-mutation');
const contract = 'github-job-v1';
type Profile = 'full' | 'fast' | 'renderer';
type Prepared = {
  version: 2;
  kind: 'local' | 'hosted';
  root: string;
  source: string;
  commit: string;
  core: string;
  snapshot: string;
  lock: string;
  node: string;
  pnpm: string;
  stryker: string;
  vitestRunner: string;
  vitest: string;
  context: string;
};

function fail(message: string): never {
  throw new Error(message);
}

// Ambient Git routing must not redirect a child into the maintainer's index/tree.
function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...environment(), GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`Git inspection failed: ${result.stderr || result.error}`);
  }
  return result.stdout.trimEnd();
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function overlap(a: string, b: string): boolean {
  return inside(a, b) || inside(b, a);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function json(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function regularFile(path: string): Buffer | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : undefined;
  } finally {
    closeSync(fd);
  }
}

function snapshot(cwd: string): string {
  const digest = createHash('sha256');
  digest.update(git(cwd, 'ls-files', '--stage', '-z'));
  digest.update(git(cwd, 'rev-parse', 'HEAD'));
  digest.update(git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)'));
  for (const name of git(cwd, 'ls-files', '-z').split('\0').filter(Boolean)) {
    const path = join(cwd, name);
    const bytes = regularFile(path);
    if (bytes !== undefined) {
      digest.update(name).update(bytes);
    }
  }
  return digest.digest('hex');
}

// Follow links only to inspect their real target. Reject escapes before any claim/write.
function files(cwd: string, contained: boolean): Set<string> {
  const identities = new Set<string>();
  const visited = new Set<string>();
  function visit(path: string): void {
    const real = realpathSync(path);
    if (contained && !inside(cwd, real)) {
      fail(`Path escapes execution checkout: ${path} -> ${real}`);
    }
    if (visited.has(real)) {
      return;
    }
    visited.add(real);
    const stat = lstatSync(real);
    if (stat.isDirectory()) {
      // Empty shared mount points have no file identity to discover below them.
      identities.add(`${stat.dev}:${stat.ino}`);
      for (const entry of readdirSync(real)) {
        visit(join(real, entry));
      }
    } else if (stat.isFile()) {
      identities.add(`${stat.dev}:${stat.ino}`);
    } else {
      fail(`Unsupported filesystem entry: ${path}`);
    }
  }
  visit(cwd);
  return identities;
}

function checkout(hosted: boolean): {
  commit: string;
  core: string;
  snapshot: string;
  lock: string;
  pnpm: string;
  stryker: string;
  vitestRunner: string;
  vitest: string;
} {
  if (process.platform !== 'linux') {
    fail('Supported runners: Linux/WSL and GitHub-hosted Ubuntu. Native Windows is refused.');
  }
  if (realpathSync(process.cwd()) !== root) {
    fail('Run from the execution checkout root.');
  }
  if (!lstatSync(join(root, '.git')).isDirectory()) {
    fail('An independent full clone with its own .git directory is required.');
  }
  for (const path of ['.git', '.git/index', '.git/config']) {
    if (lstatSync(join(root, path)).isSymbolicLink()) {
      fail(`Git metadata must not be a symlink: ${path}`);
    }
  }
  if (
    realpathSync(git(root, 'rev-parse', '--absolute-git-dir')) !== join(root, '.git') ||
    realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir'))) !== join(root, '.git')
  ) {
    fail('Shared Git metadata is not supported.');
  }
  for (const cwd of [root, join(root, 'packages/core')]) {
    if (realpathSync(git(cwd, 'rev-parse', '--show-toplevel')) !== cwd) {
      fail(`Git worktree must belong to the execution checkout: ${cwd}`);
    }
    if (git(cwd, 'status', '--porcelain', '--untracked-files=no') !== '') {
      fail(`Committed, clean tracked content required: ${cwd}`);
    }
    const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')
      .split('\0')
      .filter(Boolean);
    const deep =
      hosted &&
      cwd === root &&
      process.env.GITHUB_WORKFLOW_REF?.startsWith(
        'PiesP/yt-live-chat-overlay/.github/workflows/deep-checks.yaml@refs/'
      );
    if (
      untracked.some(
        (name) =>
          !(
            deep &&
            [
              '.deep-check-cache/mutation-fast.json',
              '.deep-check-cache/mutation-renderer.json',
            ].includes(name)
          )
      )
    ) {
      fail(`Committed, clean tracked content required; unexpected untracked inputs: ${cwd}`);
    }
    const ignored = git(
      cwd,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z'
    )
      .split('\0')
      .filter(
        (name) => name !== '' && name !== 'node_modules/' && !name.startsWith('node_modules/')
      );
    if (ignored.length > 0) {
      fail(`Fresh execution checkout required; unexpected ignored inputs: ${cwd}`);
    }
    const dir = realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir'));
    const common = realpathSync(resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')));
    if (
      !inside(join(root, '.git'), dir) ||
      !inside(join(root, '.git'), common) ||
      existsSync(join(dir, 'objects/info/alternates')) ||
      existsSync(join(common, 'objects/info/alternates'))
    ) {
      fail('Core and object storage must belong to this independent clone.');
    }
  }
  const commit = git(root, 'rev-parse', 'HEAD');
  const core = git(root, 'rev-parse', 'HEAD:packages/core');
  if (git(join(root, 'packages/core'), 'rev-parse', 'HEAD') !== core) {
    fail('Initialize the recorded packages/core revision.');
  }
  for (const path of [
    'node_modules/@piesp/browser-core',
    'node_modules/@stryker-mutator/core',
    'node_modules/@stryker-mutator/vitest-runner',
    'node_modules/vitest',
  ]) {
    if (!inside(join(root, 'node_modules'), realpathSync(join(root, path)))) {
      fail(`Dependency resolves outside the owned installed tree: ${path}`);
    }
  }
  const installedCore = realpathSync(join(root, 'node_modules/@piesp/browser-core'));
  for (const name of git(join(root, 'packages/core'), 'ls-files', '-z')
    .split('\0')
    .filter((name) => name.startsWith('src/') || name === 'package.json' || name === 'LICENSE')) {
    const original = join(root, 'packages/core', name);
    const bytes = regularFile(original);
    if (bytes !== undefined) {
      const installed = regularFile(join(installedCore, name));
      if (installed === undefined || hash(bytes) !== hash(installed)) {
        fail(`Installed file:packages/core differs from the recorded core: ${name}`);
      }
    }
  }
  const sourceLock = regularFile(join(root, 'pnpm-lock.yaml'));
  const installedLock = regularFile(join(root, 'node_modules/.pnpm/lock.yaml'));
  if (!sourceLock || !installedLock || !sourceLock.equals(installedLock)) {
    fail(
      'Installed pnpm lock differs from the selected source lock; run a frozen install in this clone.'
    );
  }
  const manager = json(join(root, 'package.json')).packageManager;
  const pnpm = spawnSync('pnpm', ['--version'], {
    cwd: root,
    env: environment(),
    encoding: 'utf8',
  });
  if (
    pnpm.status !== 0 ||
    typeof manager !== 'string' ||
    manager !== `pnpm@${pnpm.stdout.trim()}`
  ) {
    fail('Active pnpm version does not match the selected packageManager.');
  }
  const listed = spawnSync('pnpm', ['list', '--lockfile-only', '--json', '--depth', '0'], {
    cwd: root,
    env: environment(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    fail(
      `Cannot resolve pinned mutation tools from the source lock: ${listed.stderr || listed.stdout || listed.error}`
    );
  }
  let rows: unknown;
  try {
    rows = JSON.parse(listed.stdout) as unknown;
  } catch {
    fail('Pinned mutation tool listing is malformed.');
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail('Pinned mutation tool listing must contain exactly one project.');
  }
  const project = object(rows[0]);
  if (project.path !== root) {
    fail('Pinned mutation tool listing resolved a different project.');
  }
  const dependencies = object(project.devDependencies);
  const installed = {
    stryker: String(json(join(root, 'node_modules/@stryker-mutator/core/package.json')).version),
    vitestRunner: String(
      json(join(root, 'node_modules/@stryker-mutator/vitest-runner/package.json')).version
    ),
    vitest: String(json(join(root, 'node_modules/vitest/package.json')).version),
  };
  for (const [name, version] of [
    ['@stryker-mutator/core', installed.stryker],
    ['@stryker-mutator/vitest-runner', installed.vitestRunner],
    ['vitest', installed.vitest],
  ] as const) {
    const entry = dependencies[name];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`Pinned mutation tool missing from the selected lock: ${name}`);
    }
    const expected = object(entry).version;
    if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+/.test(expected) || version !== expected) {
      fail(`Installed mutation tool differs from the selected lock: ${name}`);
    }
  }
  return {
    commit,
    core,
    snapshot: hash(snapshot(root) + snapshot(join(root, 'packages/core'))),
    lock: hash(sourceLock),
    pnpm: pnpm.stdout.trim(),
    ...installed,
  };
}

function hostedContext(): string {
  const env = process.env;
  const workflow = env.GITHUB_WORKFLOW_REF ?? '';
  const expectedJob = workflow.includes('/deep-checks.yaml@refs/')
    ? ['mutation-fast', 'mutation-renderer']
    : workflow.includes('/release.yaml@refs/')
      ? ['mutation']
      : [];
  if (
    env.MUTATION_WORKSPACE_CONTRACT !== contract ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.RUNNER_OS !== 'Linux' ||
    env.GITHUB_REPOSITORY !== 'PiesP/yt-live-chat-overlay' ||
    !expectedJob.includes(env.GITHUB_JOB ?? '') ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^PiesP\/yt-live-chat-overlay\/\.github\/workflows\/(deep-checks|release)\.yaml@refs\//.test(
      workflow
    ) ||
    !env.GITHUB_WORKSPACE ||
    realpathSync(env.GITHUB_WORKSPACE) !== root ||
    !env.RUNNER_TEMP ||
    overlap(realpathSync(env.RUNNER_TEMP), root)
  ) {
    fail(
      'Hosted admission requires the explicit mutation job contract and its real job-owned checkout. CI=true is insufficient.'
    );
  }
  return [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB, env.GITHUB_WORKFLOW_REF].join(
    '/'
  );
}

function verifyIsolation(source: string): void {
  if (overlap(root, source)) {
    fail('Execution checkout and maintainer checkout must be separate, non-nested real paths.');
  }
  if (realpathSync(git(source, 'rev-parse', '--show-toplevel')) !== source) {
    fail('Source must be the maintainer checkout root.');
  }
  const origin = git(root, 'remote', 'get-url', 'origin');
  if (!isAbsolute(origin) || realpathSync(origin) !== source) {
    fail(
      'Execution origin must identify the named local maintainer source. Follow the independent clone preparation commands.'
    );
  }
  const executionFiles = files(root, true);
  for (const identity of files(source, false)) {
    if (executionFiles.has(identity)) {
      fail(
        'Execution checkout shares files or dependencies with the maintainer checkout; use --no-local and package-import-method=copy.'
      );
    }
  }
}

function prepare(kind: 'local' | 'hosted', args: string[]): void {
  const selected = kind === 'hosted' ? process.env.MUTATION_SOURCE_SHA : args[1];
  if (!selected || !/^[a-f0-9]{40}$/.test(selected) || args.length !== (kind === 'local' ? 2 : 0)) {
    fail(
      'Preparation requires an explicit full committed SHA. Local: pnpm mut:prepare /absolute/maintainer/P FULL_SHA'
    );
  }
  const context = kind === 'hosted' ? hostedContext() : '';
  const state = checkout(kind === 'hosted');
  if (state.commit !== selected) {
    fail(
      'Selected committed SHA does not match the execution checkout. Uncommitted changes are never copied or tested.'
    );
  }
  const source = kind === 'local' ? realpathSync(args[0] ?? '') : root;
  if (kind === 'local') {
    verifyIsolation(source);
    if (git(source, 'rev-parse', `${selected}^{commit}`) !== selected) {
      fail('Selected commit must exist in the named source.');
    }
  } else {
    files(root, true);
  }
  if (existsSync(metadata)) {
    fail(
      'Preparation already exists. Preserve this checkout; prepare a fresh independent clone for another analysis.'
    );
  }
  mkdirSync(metadata);
  const prepared: Prepared = {
    version: 2,
    kind,
    root,
    source,
    ...state,
    node: process.version,
    context,
  };
  writeFileSync(join(metadata, 'prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(
    `Prepared ${kind} execution checkout: ${root}\nCommitted source: ${selected}\nCore: ${state.core}\nUncommitted maintainer changes are not included. One analysis only; retain this checkout on interruption.`
  );
}

function argumentsFor(profile: Profile, args: string[], hosted: boolean): string[] {
  if (hosted && args.length) {
    fail('Hosted mutation gate does not accept profile overrides.');
  }
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--dryRunOnly') {
      forwarded.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const key = equal < 0 ? arg : arg.slice(0, equal);
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value) {
      fail(`Missing value: ${key}`);
    }
    if (key === '--concurrency' || key === '-c') {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 32) {
        fail('Concurrency must be between 1 and 32.');
      }
    } else if (key === '--logLevel') {
      if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'off'].includes(value)) {
        fail('Invalid log level.');
      }
    } else if (key === '--mutate' || key === '-m' || key === '--testFiles' || key === '-t') {
      for (const glob of value.split(',')) {
        safeRelative(glob.replace(/^!/, ''));
      }
      requireSelectedFiles(value, key === '--testFiles' || key === '-t' ? 'test' : 'mutation');
    } else {
      fail(
        `Unsupported mutation argument: ${arg}. Supported: --dryRunOnly, --concurrency/-c, --logLevel, --mutate/-m, --testFiles/-t. Paths must stay inside the execution checkout.`
      );
    }
    forwarded.push(key, value);
  }
  return [
    'run',
    profile === 'fast'
      ? 'stryker.conf.fast.json'
      : profile === 'renderer'
        ? 'stryker.conf.renderer.json'
        : 'stryker.conf.json',
    ...(profile === 'full' ? ['--reporters=progress,json'] : []),
    ...forwarded,
  ];
}

function requireSelectedFiles(value: string, kind: 'test' | 'mutation'): void {
  const selected = new Set<string>();
  const patterns = value.split(',');
  if (
    kind === 'test' &&
    patterns.some((pattern) => pattern.startsWith('!') || pattern.includes(':'))
  ) {
    fail('Diagnostic --testFiles does not support negative patterns or line ranges.');
  }
  if (!patterns.some((pattern) => !pattern.startsWith('!'))) {
    fail(`At least one positive ${kind} pattern is required.`);
  }
  for (const pattern of patterns.filter((candidate) => !candidate.startsWith('!'))) {
    const pathname =
      kind === 'mutation' ? pattern.replace(/:\d+(?::\d+)?-\d+(?::\d+)?$/, '') : pattern;
    for (const name of globSync(pathname, { cwd: root })) {
      const expectedRoot = kind === 'test' ? 'test/' : 'src/';
      if (
        name.startsWith(expectedRoot) &&
        (kind === 'mutation' || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) &&
        lstatSync(join(root, name)).isFile()
      ) {
        selected.add(name);
      }
    }
  }
  for (const pattern of patterns.filter((candidate) => candidate.startsWith('!'))) {
    const pathname = pattern.slice(1).replace(/:\d+(?::\d+)?-\d+(?::\d+)?$/, '');
    for (const name of globSync(pathname, { cwd: root })) {
      selected.delete(name);
    }
  }
  if (selected.size === 0) {
    fail(
      `Selected --${kind === 'test' ? 'testFiles' : 'mutate'} patterns match no ${kind} files in the execution checkout.`
    );
  }
}

function safeRelative(path: string): void {
  // Renderer intentionally narrows one source file to a Stryker line range.
  const pathname = path.replace(/:\d+(?::\d+)?-\d+(?::\d+)?$/, '');
  if (
    !pathname ||
    isAbsolute(pathname) ||
    !/^[A-Za-z0-9_./*?!-]+$/.test(pathname) ||
    pathname.includes('..') ||
    pathname.includes('\\') ||
    pathname.split('/').includes('..')
  ) {
    fail(`Unsafe mutation path: ${path}`);
  }
}

function profileConfig(profile: Profile): void {
  const config = json(
    join(
      root,
      profile === 'fast'
        ? 'stryker.conf.fast.json'
        : profile === 'renderer'
          ? 'stryker.conf.renderer.json'
          : 'stryker.conf.json'
    )
  );
  if (config.inPlace !== true || config.allowEmpty === true || config.buildCommand !== undefined) {
    fail(
      'Unsupported mutation profile: expected inPlace, nonempty analysis, and no build command.'
    );
  }
  for (const key of ['mutate', 'testFiles']) {
    const paths = config[key];
    if (Array.isArray(paths)) {
      for (const path of paths) {
        safeRelative(String(path).replace(/^!/, ''));
      }
      requireSelectedFiles(paths.map(String).join(','), key === 'testFiles' ? 'test' : 'mutation');
    }
  }
  for (const key of ['tempDirName', 'incrementalFile']) {
    if (config[key] !== undefined) {
      safeRelative(String(config[key]));
    }
  }
  for (const [key, field] of [
    ['jsonReporter', 'fileName'],
    ['htmlReporter', 'fileName'],
    ['vitest', 'configFile'],
  ]) {
    const value = config[key ?? ''];
    if (value !== undefined) {
      const path = object(value)[field ?? ''];
      if (path !== undefined) {
        safeRelative(String(path));
      }
    }
  }
}

async function run(profile: Profile, args: string[]): Promise<number> {
  if (!existsSync(join(metadata, 'prepared.json'))) {
    fail(
      'Mutation refused before instrumentation. Prepare a fresh independent full clone: see CONTRIBUTING.md, "Mutation runs"; then pnpm mut:prepare /absolute/maintainer/P FULL_SHA. Direct Stryker invocation bypasses this protection.'
    );
  }
  if (
    realpathSync(metadata) !== metadata ||
    lstatSync(join(metadata, 'prepared.json')).isSymbolicLink()
  ) {
    fail('Preparation record must belong to the execution checkout.');
  }
  const record = json(join(metadata, 'prepared.json'));
  if (
    record.version !== 2 ||
    record.root !== root ||
    !['local', 'hosted'].includes(String(record.kind))
  ) {
    fail('Mismatched preparation record. Prepare a fresh clone.');
  }
  if (record.kind === 'hosted') {
    hostedContext();
  }
  const state = checkout(record.kind === 'hosted');
  if (record.kind === 'hosted') {
    if (record.context !== hostedContext() || state.commit !== process.env.MUTATION_SOURCE_SHA) {
      fail('Hosted source/job identity changed.');
    }
    const job = process.env.GITHUB_JOB;
    if (
      (job === 'mutation-fast' && profile !== 'fast') ||
      (job === 'mutation-renderer' && profile !== 'renderer') ||
      (job === 'mutation' && profile !== 'fast')
    ) {
      fail('Hosted mutation profile does not match the admitted job.');
    }
    files(root, true);
  } else {
    if (typeof record.source !== 'string' || realpathSync(record.source) !== record.source) {
      fail('Maintainer path changed.');
    }
    verifyIsolation(record.source);
  }
  for (const key of [
    'commit',
    'core',
    'snapshot',
    'lock',
    'pnpm',
    'stryker',
    'vitestRunner',
    'vitest',
  ] as const) {
    if (record[key] !== state[key]) {
      fail(`Prepared ${key} changed; prepare a fresh clone.`);
    }
  }
  if (record.node !== process.version) {
    fail('Prepared Node runtime changed.');
  }
  const argv = argumentsFor(profile, args, record.kind === 'hosted');
  try {
    profileConfig(profile);
  } catch (error: unknown) {
    fail(
      `Mutation configuration failed before instrumentation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    existsSync(join(root, 'reports/mutation')) ||
    readdirSync(root).some((name) => name.startsWith('.stryker-tmp'))
  ) {
    fail('Existing mutation reports/backups are retained. Prepare a fresh clone.');
  }
  const runDir = join(metadata, 'run');
  try {
    mkdirSync(runDir);
  } catch {
    fail(
      `An analysis already claimed ${runDir}. Do not infer liveness from a PID. Inspect owned processes and preserve evidence; use a fresh clone.`
    );
  }
  const start = {
    ...record,
    profile,
    argv,
    startedAt: new Date().toISOString(),
    launcherPid: process.pid,
    report: join(root, 'reports/mutation'),
    diagnostics: runDir,
  };
  writeFileSync(join(runDir, 'start.json'), `${JSON.stringify(start, null, 2)}\n`, { flag: 'wx' });
  console.log(
    `Mutation execution checkout: ${root}\nStartup record and retained diagnostics: ${runDir}\nProfile: ${profile}; commit: ${state.commit}; core: ${state.core}; pnpm: ${state.pnpm}; Stryker: ${state.stryker}; Vitest runner: ${state.vitestRunner}; Vitest: ${state.vitest}`
  );
  const log = openSync(join(runDir, 'child.log'), 'wx');
  let interrupted: NodeJS.Signals | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let escalated = false;
  let spawnError = '';
  const child = spawn(
    process.execPath,
    [join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js'), ...argv],
    {
      cwd: root,
      env: environment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );
  writeFileSync(
    join(runDir, 'child.json'),
    `${JSON.stringify({ pid: child.pid, processGroup: child.pid, cwd: root, argv })}\n`,
    { flag: 'wx' }
  );
  const forward = (signal: NodeJS.Signals): void => {
    if (interrupted) {
      return;
    }
    interrupted = signal;
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* Child may already have exited. */
      }
    }
    escalation = setTimeout(() => {
      escalated = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* The owned group may already have exited. */
        }
      }
    }, 30_000);
  };
  const onInt = (): void => forward('SIGINT');
  const onTerm = (): void => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  child.stdout.on('data', (data: Buffer) => {
    writeSync(log, data);
    process.stdout.write(data);
  });
  child.stderr.on('data', (data: Buffer) => {
    writeSync(log, data);
    process.stderr.write(data);
  });
  child.on('error', (error: Error) => {
    spawnError = error.message;
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (done) => {
      child.on('close', (code, signal) => done({ code, signal }));
    }
  );
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  clearTimeout(escalation);
  closeSync(log);
  let restored = false;
  try {
    restored = state.snapshot === hash(snapshot(root) + snapshot(join(root, 'packages/core')));
  } catch {
    /* Preserve uncertain restoration. */
  }
  const dryRun = args.includes('--dryRunOnly');
  let reportsComplete: boolean | null = !dryRun ? false : null;
  if (reportsComplete === false && outcome.code === 0) {
    try {
      const report = json(
        join(root, `reports/mutation/${profile === 'full' ? 'mutation' : profile}.json`)
      );
      const mutants = Object.values(object(report.files)).flatMap((value) => {
        const items = object(value).mutants;
        return Array.isArray(items) ? items : [];
      });
      reportsComplete =
        mutants.length > 0 &&
        mutants.every((value) => !['Pending', 'NotRun'].includes(String(object(value).status))) &&
        (profile !== 'fast' ||
          readFileSync(join(root, 'reports/mutation/mutation.html')).length > 0);
    } catch {
      /* A zero exit without complete reports must not pass the hosted gate. */
    }
  }
  const code = interrupted
    ? interrupted === 'SIGINT'
      ? 130
      : 143
    : spawnError
      ? 2
      : outcome.code === 0 && (!restored || reportsComplete === false)
        ? 1
        : (outcome.code ?? 1);
  const status =
    interrupted || outcome.signal || outcome.code === 130 || outcome.code === 143
      ? 'interrupted'
      : spawnError
        ? 'spawn-failed'
        : outcome.code !== 0
          ? 'child-failed'
          : !restored
            ? 'restoration-unverified'
            : reportsComplete === false
              ? 'reports-incomplete'
              : dryRun
                ? 'dry-run-only'
                : 'completed';
  // Never follow redirected metadata when writing a final receipt; startup evidence remains.
  if (realpathSync(runDir) === runDir) {
    writeFileSync(
      join(runDir, 'result.json'),
      `${JSON.stringify(
        {
          status,
          exitCode: code,
          child: outcome,
          spawnError,
          interrupted,
          escalated,
          restored,
          reportsComplete,
          finishedAt: new Date().toISOString(),
          retained: root,
        },
        null,
        2
      )}\n`,
      { flag: 'wx' }
    );
  }
  console.log(
    `Mutation ${status}; exit ${code}. Retained checkout and diagnostics: ${root}, ${runDir}`
  );
  return code;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') {
    prepare('local', args);
  } else if (command === 'prepare-hosted') {
    prepare('hosted', args);
  } else if (
    command === 'run' &&
    (args[0] === 'full' || args[0] === 'fast' || args[0] === 'renderer')
  ) {
    process.exitCode = await run(args[0], args.slice(1));
  } else {
    fail(
      'Usage: mutation-workspace.ts prepare SOURCE FULL_SHA | prepare-hosted | run full|fast|renderer [supported Stryker arguments]'
    );
  }
}

const invoked = process.argv[1];
if (
  invoked &&
  existsSync(invoked) &&
  realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    console.error(
      `Mutation preparation/admission failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  });
}
