import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateReuse,
  fingerprint,
  shouldReuse,
  validMarker,
  writeMarker,
} from './deep-check-reuse.ts';

const fixture = mkdtempSync(join(tmpdir(), 'deep-check-reuse-'));
after(() => rmSync(fixture, { recursive: true, force: true }));

function write(path: string, content: string | Uint8Array) {
  const fullPath = join(fixture, path);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

function git(...args: string[]) {
  execFileSync('git', args, { cwd: fixture });
}

git('init', '-q');
write(
  'package.json',
  JSON.stringify({
    packageManager: 'pnpm@11.26.0',
    volta: { node: '26.9.0', pnpm: '11.26.0' },
  })
);
for (const path of [
  'src/app.ts',
  'test/app.test.ts',
  'stryker.conf.fast.json',
  'stryker.conf.renderer.json',
  'pnpm-lock.yaml',
  'scripts/ci/install-nose.sh',
  '.github/workflows/deep-checks.yaml',
]) {
  write(path, 'original\n');
}
git('add', '-A');
git(
  'update-index',
  '--add',
  '--cacheinfo',
  '160000,1111111111111111111111111111111111111111,packages/core'
);

const runner = {
  RUNNER_OS: 'Linux',
  RUNNER_ARCH: 'X64',
  ImageOS: 'ubuntu24',
  ImageVersion: '20261001.1',
  DEEP_RUNNER_LABEL: 'ubuntu-24.04',
  GITHUB_RUN_ID: '100',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
};
const baseline = fingerprint('duplication', fixture, runner);
if (!baseline) throw new Error('Fixture runner identity must be complete');

test('each tracked source, test, configuration, lock, and tool input invalidates success', () => {
  assert.match(baseline, /^[0-9a-f]{64}$/);
  for (const path of [
    'src/app.ts',
    'test/app.test.ts',
    'stryker.conf.fast.json',
    'stryker.conf.renderer.json',
    'pnpm-lock.yaml',
    'scripts/ci/install-nose.sh',
    '.github/workflows/deep-checks.yaml',
    'package.json',
  ]) {
    write(
      path,
      path === 'package.json'
        ? JSON.stringify({
            packageManager: 'pnpm@11.26.0',
            volta: { node: '26.9.1', pnpm: '11.26.0' },
          })
        : 'changed\n'
    );
    assert.notEqual(fingerprint('duplication', fixture, runner), baseline, path);
    if (path === 'package.json') {
      write(
        path,
        JSON.stringify({
          packageManager: 'pnpm@11.26.0',
          volta: { node: '26.9.0', pnpm: '11.26.0' },
        })
      );
    } else {
      write(path, 'original\n');
    }
  }
  assert.equal(fingerprint('duplication', fixture, runner), baseline);
  write(
    'package.json',
    JSON.stringify({
      packageManager: 'pnpm@11.26.1',
      volta: { node: '26.9.0', pnpm: '11.26.1' },
    })
  );
  assert.notEqual(fingerprint('duplication', fixture, runner), baseline);
  write(
    'package.json',
    JSON.stringify({
      packageManager: 'pnpm@11.26.0',
      volta: { node: '26.9.0', pnpm: '11.26.0' },
    })
  );
});

test('fingerprint uses the length of the bytes read when a tracked file changes', (t) => {
  const path = join(fixture, 'src/app.ts');
  const read = fs.readFileSync;
  try {
    for (const replacement of [Buffer.alloc(0), Buffer.from('changed longer content\n')]) {
      write('src/app.ts', replacement);
      const expected = fingerprint('duplication', fixture, runner);
      write('src/app.ts', 'original\n');
      let replaced = false;
      t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
        const [file] = args;
        if (file === path && !replaced) {
          // Change the file at the read boundary, after any separate metadata lookup.
          writeFileSync(path, replacement);
          replaced = true;
        }
        return read(...args);
      });
      syncBuiltinESMExports();
      assert.equal(fingerprint('duplication', fixture, runner), expected);
      assert.equal(replaced, true);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    write('src/app.ts', 'original\n');
  }
  assert.equal(fingerprint('duplication', fixture, runner), baseline);
});

test('gitlink, runner platform and label, and gate identity invalidate success', () => {
  git(
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,2222222222222222222222222222222222222222,packages/core'
  );
  assert.notEqual(fingerprint('duplication', fixture, runner), baseline);
  git(
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,1111111111111111111111111111111111111111,packages/core'
  );
  for (const change of [
    { RUNNER_OS: 'Windows' },
    { RUNNER_ARCH: 'ARM64' },
    { ImageOS: 'ubuntu26' },
    { DEEP_RUNNER_LABEL: 'ubuntu-26.04' },
  ]) {
    assert.notEqual(fingerprint('duplication', fixture, { ...runner, ...change }), baseline);
  }
  assert.equal(
    fingerprint('duplication', fixture, { ...runner, ImageVersion: '20261001.2' }),
    baseline
  );
  const fast = fingerprint('mutation-fast', fixture, runner);
  const renderer = fingerprint('mutation-renderer', fixture, runner);
  assert.notEqual(fast, baseline);
  assert.notEqual(renderer, baseline);
  assert.notEqual(fast, renderer);
  assert.equal(fingerprint('duplication', fixture, { ...runner, ImageVersion: '' }), null);
  assert.equal(fingerprint('duplication', fixture, { ...runner, DEEP_RUNNER_LABEL: '' }), null);
});

test('only a valid successful marker can be reused', () => {
  const marker = join(fixture, 'marker.json');
  assert.equal(validMarker(marker, 'duplication', baseline), false);
  writeMarker(marker, 'duplication', baseline, runner);
  assert.equal(validMarker(marker, 'duplication', baseline), true);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).imageVersion, runner.ImageVersion);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).runId, 100);
  assert.equal(
    validMarker(
      marker,
      'duplication',
      fingerprint('duplication', fixture, {
        ...runner,
        ImageVersion: '20261001.2',
      })
    ),
    true
  );
  assert.equal(validMarker(marker, 'mutation-fast', baseline), false);
  assert.equal(validMarker(marker, 'mutation-renderer', baseline), false);
  assert.equal(validMarker(marker, 'duplication', '0'.repeat(64)), false);
  writeFileSync(
    marker,
    JSON.stringify({
      schema: 3,
      gate: 'duplication',
      fingerprint: baseline,
      result: 'failure',
      imageVersion: runner.ImageVersion,
    })
  );
  assert.equal(validMarker(marker, 'duplication', baseline), false);
  writeFileSync(marker, 'corrupt');
  assert.equal(validMarker(marker, 'duplication', baseline), false);
});

test('schedule reuses success; manual defaults to fresh and can opt in', () => {
  const decide = (
    valid: boolean,
    event: string,
    choice: string,
    hit = 'true',
    outcome = 'success'
  ) => shouldReuse(valid, hit, outcome, event, choice);
  assert.equal(decide(true, 'schedule', ''), true);
  assert.equal(decide(false, 'schedule', ''), false);
  assert.equal(decide(true, 'schedule', '', '', 'success'), false);
  assert.equal(decide(true, 'schedule', '', 'true', 'failure'), false);
  assert.equal(decide(true, 'workflow_dispatch', ''), false);
  assert.equal(decide(true, 'workflow_dispatch', 'false'), false);
  assert.equal(decide(true, 'workflow_dispatch', 'true'), true);
  assert.equal(decide(true, 'push', 'true'), false);
});

const analyzedAt = '2026-09-30T01:05:00Z';
const oldRun: {
  id: number;
  run_attempt: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
} = {
  id: 100,
  run_attempt: 1,
  head_sha: runner.GITHUB_SHA,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-09-30T00:50:00Z',
  updated_at: '2026-09-30T01:07:00Z',
};
const laterRun = {
  ...oldRun,
  id: 101,
  head_sha: 'b'.repeat(40),
  created_at: '2026-09-30T02:00:00Z',
  updated_at: '2026-09-30T02:20:00Z',
};
const oldJob: {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
} = {
  name: '🔍 Duplication',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-09-30T01:00:00Z',
  completed_at: '2026-09-30T01:04:00Z',
};
const verifyEnv = {
  ...runner,
  CACHE_HIT: 'true',
  RESTORE_OUTCOME: 'success',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_REPOSITORY: 'PiesP/yt-live-chat-overlay',
  GITHUB_REF: 'refs/heads/master',
  DEFAULT_BRANCH: 'master',
  GITHUB_RUN_ID: '103',
  GH_TOKEN: 'test-token',
};

function markerWithTime(path: string, time = analyzedAt, source = runner) {
  writeMarker(path, 'duplication', baseline!, source);
  const marker = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  marker.analyzedAt = time;
  writeFileSync(path, JSON.stringify(marker));
}

function historyApi(
  runs = [oldRun],
  jobs: Record<number, (typeof oldJob)[]> = { 100: [oldJob] },
  override?: (url: URL) => unknown
) {
  const requests: string[] = [];
  const api = async (rawUrl: string) => {
    const url = new URL(rawUrl);
    requests.push(url.pathname + url.search);
    const custom = override?.(url);
    let body: unknown;
    if (custom !== undefined) body = custom;
    else if (url.pathname.endsWith('/runs')) {
      const page = Number(url.searchParams.get('page'));
      body = { total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) };
    } else {
      const match = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(url.pathname);
      if (!match) throw new Error(`Unexpected API path: ${url.pathname}`);
      const list = jobs[Number(match[1])] ?? [];
      const page = Number(url.searchParams.get('page'));
      body = { total_count: list.length, jobs: list.slice((page - 1) * 100, page * 100) };
    }
    return { ok: true, json: async () => body };
  };
  return { api, requests };
}

test('verified origin reuses success and reports the completed job duration', async () => {
  const marker = join(fixture, 'history-marker.json');
  markerWithTime(marker);
  const { api, requests } = historyApi();
  assert.deepEqual(await evaluateReuse(marker, 'duplication', baseline, verifyEnv, api), {
    reuse: true,
    reason: 'validated-history',
    savedSeconds: 240,
  });
  assert.ok(requests.some((request) => request.includes('/attempts/1/jobs')));
});

test('later failed, cancelled, and ongoing selected gates invalidate a prior success', async () => {
  const marker = join(fixture, 'history-marker.json');
  markerWithTime(marker);
  for (const [status, conclusion] of [
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['in_progress', null],
  ] as const) {
    const changed = { ...laterRun, status, conclusion };
    const { api } = historyApi([changed, oldRun], {
      100: [oldJob],
      101: [{ ...oldJob, status, conclusion }],
    });
    const decision = await evaluateReuse(marker, 'duplication', baseline, verifyEnv, api);
    assert.equal(decision.reuse, false, `${status}/${conclusion}`);
  }
  // A failure that finished while the origin job was marking success must not
  // hide behind the marker's later local timestamp.
  const interleaved = {
    ...oldRun,
    id: 99,
    created_at: '2026-09-30T00:30:00Z',
    updated_at: '2026-09-30T01:04:30Z',
    conclusion: 'failure',
  };
  const history = historyApi([oldRun, interleaved], {
    100: [oldJob],
    99: [{ ...oldJob, conclusion: 'failure', completed_at: '2026-09-30T01:04:30Z' }],
  });
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, history.api)).reason,
    'newer-gate-invalid'
  );
});

test('complete second pages of workflow runs and jobs are required', async () => {
  const marker = join(fixture, 'history-marker.json');
  markerWithTime(marker);
  const older = Array.from({ length: 100 }, (_, index) => ({
    ...oldRun,
    id: 1000 + index,
    created_at: '2026-09-29T00:00:00Z',
    updated_at: '2026-09-29T00:05:00Z',
  }));
  const unrelatedJobs = Array.from({ length: 100 }, (_, index) => ({
    ...oldJob,
    name: `Other ${index}`,
  }));
  const complete = historyApi([...older, oldRun], { 100: [...unrelatedJobs, oldJob] });
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, complete.api)).reuse,
    true
  );
  assert.ok(
    complete.requests.some((request) => request.includes('/runs?') && request.includes('page=2'))
  );
  assert.ok(
    complete.requests.some((request) => request.includes('/jobs?') && request.includes('page=2'))
  );
  const rerun = {
    ...oldRun,
    id: 99,
    created_at: '2026-09-29T00:00:00Z',
    updated_at: '2026-09-30T01:04:30Z',
    conclusion: 'failure',
  };
  const invalid = historyApi([...older.slice(0, 99), oldRun, rerun], {
    100: [oldJob],
    99: [{ ...oldJob, conclusion: 'failure' }],
  });
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, invalid.api)).reason,
    'newer-gate-invalid'
  );
});

test('skipped unrelated gate is safe, while missing selected gate and reruns run fresh', async () => {
  const marker = join(fixture, 'history-marker.json');
  markerWithTime(marker);
  const skipped = historyApi([laterRun, oldRun], {
    100: [oldJob],
    101: [{ ...oldJob, conclusion: 'skipped' }],
  });
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, skipped.api)).reuse,
    true
  );
  const missing = historyApi([laterRun, oldRun], { 100: [oldJob], 101: [] });
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, missing.api)).reason,
    'gate-history-incomplete'
  );
  const rerun = historyApi([{ ...oldRun, run_attempt: 2 }, laterRun], { 100: [oldJob] });
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, rerun.api)).reason,
    'origin-invalid'
  );
  const olderRerun = historyApi(
    [oldRun, { ...oldRun, id: 99, updated_at: '2026-09-30T03:00:00Z', conclusion: 'failure' }],
    { 100: [oldJob], 99: [{ ...oldJob, conclusion: 'failure' }] }
  );
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, olderRerun.api)).reason,
    'newer-gate-invalid'
  );
});

test('a newer successful marker restores reuse after the earlier failed run', async () => {
  const marker = join(fixture, 'recovered-marker.json');
  const recovered = { ...runner, GITHUB_RUN_ID: '102', GITHUB_SHA: 'c'.repeat(40) };
  markerWithTime(marker, '2026-09-30T04:05:00Z', recovered);
  const recoveredRun = {
    ...laterRun,
    id: 102,
    head_sha: recovered.GITHUB_SHA,
    created_at: '2026-09-30T04:00:00Z',
    updated_at: '2026-09-30T04:07:00Z',
  };
  const recoveredJob = {
    ...oldJob,
    started_at: '2026-09-30T04:00:00Z',
    completed_at: '2026-09-30T04:04:00Z',
  };
  const { api } = historyApi([recoveredRun, { ...laterRun, conclusion: 'failure' }, oldRun], {
    102: [recoveredJob],
  });
  assert.equal((await evaluateReuse(marker, 'duplication', baseline, verifyEnv, api)).reuse, true);
});

test('unavailable, truncated, or forged Actions history always runs fresh', async () => {
  const marker = join(fixture, 'history-marker.json');
  markerWithTime(marker);
  const absent = historyApi([laterRun]);
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, absent.api)).reason,
    'origin-invalid'
  );
  const unavailable = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, unavailable)).reason,
    'api-unavailable-or-incomplete'
  );
  const truncated = historyApi([oldRun], { 100: [oldJob] }, (url) =>
    url.pathname.endsWith('/runs') ? { total_count: 101, workflow_runs: [oldRun] } : undefined
  );
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, truncated.api)).reason,
    'api-unavailable-or-incomplete'
  );
  markerWithTime(marker, '2099-01-01T00:00:00Z');
  assert.equal(validMarker(marker, 'duplication', baseline), false);
  markerWithTime(marker, '2026-09-30T00:55:00Z');
  const validApi = historyApi();
  assert.equal(
    (await evaluateReuse(marker, 'duplication', baseline, verifyEnv, validApi.api)).reason,
    'origin-invalid'
  );
});

test('CLI fails closed when Actions history cannot be authenticated', () => {
  const script = fileURLToPath(new URL('./deep-check-reuse.ts', import.meta.url));
  const output = join(fixture, 'output.txt');
  const marker = join(fixture, 'cli-marker.json');
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    writeFileSync(output, '');
    execFileSync(process.execPath, ['--experimental-strip-types', script, ...args], {
      cwd: fixture,
      env: { ...process.env, ...runner, GITHUB_OUTPUT: output, ...extraEnv },
    });
    return readFileSync(output, 'utf8');
  };
  assert.match(run(['fingerprint', 'duplication']), new RegExp(`fingerprint=${baseline}`));
  const verifyEnv = {
    CACHE_HIT: 'true',
    RESTORE_OUTCOME: 'success',
    GITHUB_EVENT_NAME: 'schedule',
  };
  assert.match(run(['verify', 'duplication', baseline, marker], verifyEnv), /reuse=false/);
  run(['mark', 'duplication', baseline, marker]);
  assert.match(run(['verify', 'duplication', baseline, marker], verifyEnv), /reuse=false/);
  assert.match(
    run(['verify', 'duplication', baseline, marker], verifyEnv),
    /reason=provenance-unavailable/
  );
  assert.match(run(['verify', 'duplication', baseline, marker], verifyEnv), /origin_run_id=100/);
  assert.match(
    run(['verify', 'duplication', baseline, marker], {
      ...verifyEnv,
      RESTORE_OUTCOME: 'failure',
    }),
    /reuse=false/
  );
});

test('mutation gates use independent job history', async () => {
  const fast = fingerprint('mutation-fast', fixture, runner);
  const renderer = fingerprint('mutation-renderer', fixture, runner);
  if (!fast || !renderer) throw new Error('Mutation fixture fingerprints must be complete');
  for (const [gate, name, otherName, expected] of [
    ['mutation-fast', '🧬 Fast mutation', '🎨 Renderer mutation', fast],
    ['mutation-renderer', '🎨 Renderer mutation', '🧬 Fast mutation', renderer],
  ] as const) {
    const marker = join(fixture, `${gate}-history-marker.json`);
    writeMarker(marker, gate, expected, runner);
    const contents = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
    contents.analyzedAt = analyzedAt;
    writeFileSync(marker, JSON.stringify(contents));
    const originJob = { ...oldJob, name };
    const origin = historyApi([oldRun], { 100: [originJob] });
    assert.equal((await evaluateReuse(marker, gate, expected, verifyEnv, origin.api)).reuse, true);
    const unrelatedFailure = historyApi([laterRun, oldRun], {
      100: [originJob],
      101: [
        { ...originJob, conclusion: 'skipped' },
        { ...oldJob, name: otherName, conclusion: 'failure' },
      ],
    });
    assert.equal(
      (await evaluateReuse(marker, gate, expected, verifyEnv, unrelatedFailure.api)).reuse,
      true
    );
    const selectedFailure = historyApi([laterRun, oldRun], {
      100: [originJob],
      101: [
        { ...originJob, conclusion: 'failure' },
        { ...oldJob, name: otherName, conclusion: 'success' },
      ],
    });
    assert.equal(
      (await evaluateReuse(marker, gate, expected, verifyEnv, selectedFailure.api)).reason,
      'newer-gate-invalid'
    );
  }
});

test('both mutation markers follow their required successful report uploads', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/deep-checks.yaml', import.meta.url)),
    'utf8'
  );
  for (const profile of [
    { gate: 'mutation-fast', name: 'fast', report: 'reports/mutation/' },
    { gate: 'mutation-renderer', name: 'renderer', report: 'reports/mutation/renderer.json' },
  ]) {
    const section = workflow.split(`\n  ${profile.gate}:\n`)[1]?.split(/\n {2}[a-z][\w-]*:\n/)[0];
    assert.ok(section, profile.gate);
    const starts = [...section.matchAll(/^ {6}- name: /gm)].map((match) => match.index);
    const steps = starts.map((start, index) => section.slice(start, starts[index + 1]));
    const byName = (name: string) =>
      steps.findIndex((step) => step.startsWith(`      - name: ${name}`));
    const check = byName(
      profile.name === 'fast' ? '🧬 Run fast mutation gate' : '🎨 Run renderer mutation gate'
    );
    const upload = byName(`📤 Upload ${profile.name} mutation report`);
    const setup = byName('📦 Set up project');
    const marker = byName(`🔎 Validate successful ${profile.name} mutation marker`);
    const summary = byName(`✅ Record fresh ${profile.name} mutation pass`);
    const mark = byName(`📝 Mark successful ${profile.name} mutation`);
    const save = byName(`💾 Save successful ${profile.name} mutation marker`);
    assert.ok(marker >= 0 && marker < setup && setup < check);
    assert.ok(check < upload && upload < summary && summary < mark && mark < save);
    assert.equal(save, steps.length - 1);
    assert.match(steps[setup]!, /if:.*steps\.marker\.outputs\.reuse != 'true'/);
    assert.match(steps[check]!, /if:.*steps\.marker\.outputs\.reuse != 'true'/);
    assert.match(steps[upload]!, /id: upload/);
    assert.match(steps[upload]!, /if:.*steps\.check\.outcome != 'skipped'/);
    assert.ok(steps[upload]!.includes(`path: ${profile.report}`));
    assert.match(steps[upload]!, /if-no-files-found: error/);
    for (const step of [steps[summary]!, steps[mark]!]) {
      assert.match(
        step,
        /steps\.check\.outcome == 'success' && steps\.upload\.outcome == 'success'/
      );
    }
    assert.match(steps[save]!, /if:.*steps\.mark\.outcome == 'success'/);
    assert.ok(section.includes(`deep-success-v3-${profile.gate}-`));
  }
});

test('each deep job pins Node before fingerprint without installing dependencies', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/deep-checks.yaml', import.meta.url)),
    'utf8'
  );
  assert.doesNotMatch(workflow, /^ {2}changes:/m);
  assert.match(workflow, /reuse_success:\n\s+description:.*\n\s+required: true\n\s+default: false/);
  for (const gate of ['duplication', 'mutation-fast', 'mutation-renderer']) {
    const job = workflow.split(`\n  ${gate}:\n`)[1]?.split(/\n {2}[a-z][\w-]*:\n/)[0];
    assert.ok(job, gate);
    const checkout = job.indexOf('      - name: 📥 Checkout code');
    const setup = job.indexOf('      - name: 📦 Setup pinned Node and pnpm');
    const fingerprint = job.indexOf('      - name: 🔑 Fingerprint');
    assert.ok(checkout >= 0 && checkout < setup && setup < fingerprint);
    assert.match(
      job.slice(setup, fingerprint),
      /uses: PiesP\/browser-core\/automation\/actions\/setup-project@[0-9a-f]{40}/
    );
    assert.match(job.slice(setup, fingerprint), /install-dependencies: 'false'/);
    assert.match(
      job.slice(fingerprint),
      /node --experimental-strip-types scripts\/ci\/deep-check-reuse\.ts fingerprint/
    );
  }
});
