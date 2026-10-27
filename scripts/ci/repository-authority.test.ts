import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, test } from 'vite-plus/test';

import { parseGate } from './dependabot-apply.ts';

const dir = fileURLToPath(new URL('.', import.meta.url));
const head = 'a'.repeat(40);
const other = 'b'.repeat(40);
const consumerBase = 'c'.repeat(40);
const repository = 'PiesP/yt-live-chat-overlay';
const temporaryFixtures: string[] = [];

test('policy tests run without a browser environment', () => {
  assert.equal('window' in globalThis, false);
  assert.equal('document' in globalThis, false);
});

afterAll(() => {
  for (const path of temporaryFixtures) rmSync(path, { recursive: true, force: true });
});

type Rule = {
  match: string;
  result?: string;
  code?: number;
  results?: string[];
  signal?: NodeJS.Signals;
};

function fixture(rules: Rule[]) {
  const root = mkdtempSync(join(tmpdir(), 'repository-authority-'));
  temporaryFixtures.push(root);
  const plan = join(root, 'plan.json');
  const log = join(root, 'calls.jsonl');
  const output = join(root, 'output');
  const summary = join(root, 'summary');
  const envFile = join(root, 'env');
  writeFileSync(
    plan,
    JSON.stringify([
      ...rules,
      {
        match: 'git ls-remote origin refs/heads/master',
        result: `${consumerBase}\trefs/heads/master`,
      },
      {
        match: 'git ls-remote https://github.com/PiesP/browser-core.git refs/heads/master',
        result: `${head}\trefs/heads/master`,
      },
      { match: 'git rev-parse origin/master', result: consumerBase },
      { match: 'git -C packages/core rev-parse origin/master', result: head },
    ])
  );
  for (const path of [log, output, summary, envFile]) writeFileSync(path, '');
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const key = process.argv[1].split('/').at(-1) + ' ' + args.join(' ');
const calls = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
const count = calls.filter(call => call.key === key).length;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({key}) + '\\n');
const rule = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8')).find(item => key.includes(item.match));
if (!rule) { console.error('Unexpected fake command: ' + key); process.exit(98); }
if (rule.signal) process.kill(process.pid, rule.signal);
process.stdout.write(rule.results ? (rule.results[count] ?? rule.results.at(-1)) : (rule.result ?? ''));
process.exit(rule.code ?? 0);
`;
  for (const name of ['git', 'gh']) {
    const path = join(root, name);
    writeFileSync(path, fake, { mode: 0o755 });
  }
  return {
    root,
    log,
    output,
    summary,
    envFile,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`,
      FAKE_PLAN: plan,
      FAKE_LOG: log,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: envFile,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REPOSITORY: repository,
    },
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { key: string })
        .map((item) => item.key),
  };
}

function cli(file: string, mode: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--experimental-strip-types', join(dir, file), mode], {
    env,
    encoding: 'utf8',
  });
}

function publicationEnv(f: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  return {
    ...f.env,
    CORE_REPOSITORY: 'PiesP/browser-core',
    CONSUMER_BASE_SHA: consumerBase,
    CORE_MASTER_SHA: head,
    CLASSIFIED_BASE_SHA: other,
    CLASSIFIED_CONSUMER_BASE_SHA: consumerBase,
    CLASSIFIED_CORE_SHA: head,
    CLASSIFIED_CORE_MASTER_SHA: head,
    CLASSIFIED_REMOTE_BRANCH_SHA: '',
    CLASSIFIED_PR_NUMBER: '',
  };
}

test('CLIs preserve child failures and stay inert on unrelated missing argv paths', () => {
  for (const [file, mode] of [
    ['dependabot-apply.ts', 'validate'],
    ['update-browser-core.ts', 'prepare'],
  ]) {
    const f = fixture([
      { match: file === 'dependabot-apply.ts' ? 'gh api' : 'git ls-remote', code: 7 },
    ]);
    const result = cli(file ?? '', mode ?? '', {
      ...f.env,
      PR_NUMBER: '12',
      HEAD_SHA: head,
      BASE_REF: 'master',
      CORE_REPOSITORY: 'PiesP/browser-core',
    });
    assert.equal(result.status, 7, result.stderr);
    const imported = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `process.argv[1] = ${JSON.stringify(join(f.root, 'absent.ts'))}; await import(${JSON.stringify(new URL(file ?? '', import.meta.url).href)});`,
      ],
      { env: f.env, encoding: 'utf8' }
    );
    assert.equal(imported.status, 0, imported.stderr);
  }
});

const pull = (sha = head) =>
  JSON.stringify({
    user: { login: 'dependabot[bot]' },
    head: { repo: { full_name: repository }, sha },
    base: { ref: 'master' },
    draft: false,
    state: 'open',
  });

test('gate accepts the expected artifact and rejects altered identity or decisions', () => {
  const gate = {
    schema_version: 1,
    repository,
    pull_request_number: 12,
    head_sha: head,
    base_ref: 'master',
    eligible: true,
    reason: 'safe npm patch/minor set',
  };
  assert.deepEqual(parseGate(gate, repository), {
    eligible: true,
    number: '12',
    head,
    base: 'master',
    reason: gate.reason,
  });
  assert.throws(() => parseGate({ ...gate, repository: 'attacker/repo' }, repository));
  assert.throws(() => parseGate({ ...gate, head_sha: 'bad' }, repository));
  assert.throws(() => parseGate({ ...gate, base_ref: 'master\neligible=true' }, repository));
  assert.throws(() => parseGate({ ...gate, eligible: 'true' }, repository));
  assert.throws(() => parseGate({ ...gate, reason: 'approve anything' }, repository));
});

test('validation checks paginated commit provenance and the live head twice', () => {
  const f = fixture([
    {
      match: `gh api --paginate --slurp repos/${repository}/pulls/12/commits`,
      result: JSON.stringify([
        [
          {
            sha: head,
            author: { login: 'dependabot[bot]' },
            committer: { login: 'web-flow' },
            commit: { verification: { verified: true } },
          },
        ],
      ]),
    },
    { match: `gh api repos/${repository}/pulls/12`, results: [pull(), pull()] },
    { match: `gh api repos/${repository}`, result: JSON.stringify({ default_branch: 'master' }) },
  ]);
  const env = { ...f.env, PR_NUMBER: '12', HEAD_SHA: head, BASE_REF: 'master' };
  const result = cli('dependabot-apply.ts', 'validate', env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    f.calls().filter((call) => call.includes('/pulls/12') && !call.includes('/commits')).length,
    2
  );
});

test('validation fails closed when the head moves during provenance checks', () => {
  const f = fixture([
    {
      match: `gh api --paginate --slurp repos/${repository}/pulls/12/commits`,
      result: JSON.stringify([
        [
          {
            sha: head,
            author: { login: 'dependabot[bot]' },
            committer: { login: 'web-flow' },
            commit: { verification: { verified: true } },
          },
        ],
      ]),
    },
    { match: `gh api repos/${repository}/pulls/12`, results: [pull(), pull(other)] },
    { match: `gh api repos/${repository}`, result: JSON.stringify({ default_branch: 'master' }) },
  ]);
  const result = cli('dependabot-apply.ts', 'validate', {
    ...f.env,
    PR_NUMBER: '12',
    HEAD_SHA: head,
    BASE_REF: 'master',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Head changed/);
});

test('approval posts the exact head only if an exact-head approval is absent', () => {
  const f = fixture([
    {
      match: `gh api --paginate --slurp repos/${repository}/pulls/12/reviews`,
      result: JSON.stringify([
        [{ user: { login: 'github-actions[bot]' }, state: 'APPROVED', commit_id: other }],
      ]),
    },
    { match: `gh api --method POST repos/${repository}/pulls/12/reviews`, result: '{}' },
  ]);
  const result = cli('dependabot-apply.ts', 'approve', {
    ...f.env,
    PR_NUMBER: '12',
    HEAD_SHA: head,
    BASE_REF: 'master',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls().at(-1) ?? '', new RegExp(`commit_id=${head}`));
});

test('prepare skips classification on a master push without a same-repository PR', () => {
  const f = fixture([
    {
      match: 'git ls-remote https://github.com/PiesP/browser-core.git refs/heads/master',
      result: `${head}\trefs/heads/master`,
    },
    { match: 'git ls-remote --heads origin automation/update-browser-core', result: '' },
    {
      match: 'gh pr list',
      result: JSON.stringify([
        { number: 12, headRepository: { nameWithOwner: 'fork/repo' }, isCrossRepository: true },
      ]),
    },
  ]);
  const result = cli('update-browser-core.ts', 'prepare', {
    ...f.env,
    CORE_REPOSITORY: 'PiesP/browser-core',
    GITHUB_EVENT_NAME: 'push',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.output, 'utf8'), 'ready=false\n');
  assert.equal(
    f.calls().some((call) => call.includes('git fetch')),
    false
  );
});

test('prepare skips a pure no-op but keeps an open PR eligible for reconciliation', () => {
  for (const pr of ['', '12']) {
    const f = fixture([
      {
        match: 'git ls-remote --heads origin automation/update-browser-core',
        result: pr ? `${other}\trefs/heads/automation/update-browser-core` : '',
      },
      {
        match: 'gh pr list',
        result: pr
          ? JSON.stringify([
              {
                number: 12,
                headRepository: { nameWithOwner: repository },
                isCrossRepository: false,
              },
            ])
          : '[]',
      },
      { match: 'git fetch origin master', result: '' },
      { match: 'git switch -C', result: '' },
      { match: 'git config', result: '' },
      { match: 'git rev-parse origin/master:packages/core', result: head },
      { match: 'git clone', result: '' },
      { match: 'git -C packages/core fetch', result: '' },
      { match: `git -C packages/core cat-file -e ${head}^{commit}`, result: '' },
      { match: `git -C packages/core merge-base --is-ancestor ${head} origin/master`, result: '' },
      { match: `git -C packages/core merge-base --is-ancestor ${head} ${head}`, result: '' },
    ]);
    const result = cli('update-browser-core.ts', 'prepare', {
      ...f.env,
      CORE_REPOSITORY: 'PiesP/browser-core',
      INPUT_CORE_SHA: head,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(f.output, 'utf8');
    assert.match(output, new RegExp(`ready=${Boolean(pr)}`));
    assert.match(output, new RegExp(`consumer_base=${consumerBase}`));
    assert.match(output, new RegExp(`open_pr=${Boolean(pr)}`));
    assert.match(output, new RegExp(`pr_number=${pr}\\n`));
  }
});

test('publish rejects invalid impact before any remote write', () => {
  const f = fixture([]);
  const result = cli('update-browser-core.ts', 'publish', {
    ...publicationEnv(f),
    CORE_SHA: head,
    CURRENT_CORE_SHA: other,
    CONSUMER_IMPACT: 'unknown',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid consumer impact/);
  assert.deepEqual(f.calls(), []);
});

test('publication rejects changed or malformed classified identities before executing commands', () => {
  const mismatches = [
    { CLASSIFIED_BASE_SHA: head },
    { CLASSIFIED_CONSUMER_BASE_SHA: other },
    { CLASSIFIED_CORE_SHA: other },
    { CLASSIFIED_CORE_MASTER_SHA: other },
    { CLASSIFIED_REMOTE_BRANCH_SHA: other },
    { CLASSIFIED_PR_NUMBER: '12' },
    { CLASSIFIED_CORE_SHA: 'malformed' },
  ];
  for (const mismatch of mismatches) {
    const f = fixture([]);
    const result = cli('update-browser-core.ts', 'publish', {
      ...publicationEnv(f),
      CORE_SHA: head,
      CURRENT_CORE_SHA: other,
      CONSUMER_IMPACT: 'true',
      ...mismatch,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed after read-only classification|Invalid classified/);
    assert.deepEqual(f.calls(), []);
  }
});

test('publication rechecks live consumer and core masters before remote mutation', () => {
  for (const changed of ['consumer', 'core']) {
    const f = fixture([
      {
        match: 'git ls-remote origin refs/heads/master',
        result: `${changed === 'consumer' ? other : consumerBase}\trefs/heads/master`,
      },
      {
        match: 'git ls-remote https://github.com/PiesP/browser-core.git refs/heads/master',
        result: `${changed === 'core' ? other : head}\trefs/heads/master`,
      },
    ]);
    const result = cli('update-browser-core.ts', 'publish', {
      ...publicationEnv(f),
      CORE_SHA: head,
      CURRENT_CORE_SHA: other,
      CONSUMER_IMPACT: 'true',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed before publication/);
    assert.equal(
      f.calls().some((call) => call.includes('git add') || call.includes('gh pr close')),
      false
    );
  }
});

test('stale PR close requires the observed branch and PR head to remain unchanged', () => {
  const prState = (prHead: string) =>
    JSON.stringify({
      state: 'open',
      head: { sha: prHead, repo: { full_name: repository } },
      base: { ref: 'master' },
    });
  for (const changed of ['none', 'branch', 'pr']) {
    const f = fixture([
      {
        match: 'git ls-remote --heads origin automation/update-browser-core',
        result: `${changed === 'branch' ? head : other}\trefs/heads/automation/update-browser-core`,
      },
      {
        match: `gh api repos/${repository}/pulls/12`,
        result: prState(changed === 'pr' ? head : other),
      },
      { match: 'gh pr close 12', result: '' },
    ]);
    const result = cli('update-browser-core.ts', 'publish', {
      ...publicationEnv(f),
      CORE_SHA: head,
      CURRENT_CORE_SHA: other,
      REMOTE_BRANCH_SHA: other,
      CLASSIFIED_REMOTE_BRANCH_SHA: other,
      OPEN_PR: '12',
      CLASSIFIED_PR_NUMBER: '12',
      CONSUMER_IMPACT: 'false',
    });
    if (changed === 'none') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.calls().filter((call) => call.includes('gh pr close')).length, 1);
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(
        f.calls().some((call) => call.includes('gh pr close')),
        false
      );
    }
  }
});

test('dry-run never closes a stale PR or publishes a changed gitlink', () => {
  for (const impact of ['false', 'true']) {
    const f = fixture([
      { match: `git -C packages/core checkout --detach ${head}`, result: '' },
      { match: 'git diff --quiet -- packages/core', code: 1 },
    ]);
    const result = cli('update-browser-core.ts', 'publish', {
      ...publicationEnv(f),
      CORE_SHA: head,
      CURRENT_CORE_SHA: other,
      OPEN_PR: '12',
      CONSUMER_IMPACT: impact,
      DRY_RUN: 'true',
      PREFLIGHT: 'true',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      f
        .calls()
        .some(
          (call) =>
            call.startsWith('gh ') || call.startsWith('git push') || call.startsWith('git add')
        ),
      false
    );
  }
});

test('publish summarizes an existing gitlink without remote mutation', () => {
  const f = fixture([
    { match: `git -C packages/core checkout --detach ${head}`, result: '' },
    { match: 'git diff --quiet -- packages/core', result: '' },
  ]);
  const result = cli('update-browser-core.ts', 'publish', {
    ...publicationEnv(f),
    CORE_SHA: head,
    CURRENT_CORE_SHA: head,
    CLASSIFIED_BASE_SHA: head,
    CONSUMER_IMPACT: 'true',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.summary, 'utf8'), /- Result: no update required/);
  assert.match(readFileSync(f.summary, 'utf8'), /- PR action: No stale update PR was open\./);
  assert.equal(
    f.calls().some((call) => call.includes('git push')),
    false
  );
});

test('publish stops before push when the generated commit changes another file', () => {
  const f = fixture([
    { match: `git -C packages/core checkout --detach ${head}`, result: '' },
    { match: 'git diff --quiet -- packages/core', code: 1 },
    { match: 'git add packages/core', result: '' },
    { match: 'git commit -m', result: '' },
    { match: 'git rev-parse HEAD', result: other },
    { match: 'git diff --name-only origin/master...HEAD', result: 'packages/core\nREADME.md' },
  ]);
  const result = cli('update-browser-core.ts', 'publish', {
    ...publicationEnv(f),
    CORE_SHA: head,
    CURRENT_CORE_SHA: other,
    CONSUMER_IMPACT: 'true',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-gitlink changes/);
  assert.equal(
    f.calls().some((call) => call.includes('git push')),
    false
  );
});

test('validation rejects a commit without Dependabot provenance', () => {
  const f = fixture([
    {
      match: `gh api --paginate --slurp repos/${repository}/pulls/12/commits`,
      result: JSON.stringify([
        [
          {
            sha: head,
            author: { login: 'dependabot[bot]' },
            committer: { login: 'attacker' },
            commit: { verification: { verified: true } },
          },
        ],
      ]),
    },
    { match: `gh api repos/${repository}/pulls/12`, result: pull() },
    { match: `gh api repos/${repository}`, result: JSON.stringify({ default_branch: 'master' }) },
  ]);
  const result = cli('dependabot-apply.ts', 'validate', {
    ...f.env,
    PR_NUMBER: '12',
    HEAD_SHA: head,
    BASE_REF: 'master',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unverified Dependabot commit/);
  assert.equal(
    f.calls().filter((call) => call.includes('/pulls/12') && !call.includes('/commits')).length,
    1
  );
});

test('prepare rejects an unreachable target before publishing outputs', () => {
  const f = fixture([
    { match: 'git ls-remote --heads origin automation/update-browser-core', result: '' },
    { match: 'gh pr list', result: '[]' },
    { match: 'git fetch origin master', result: '' },
    { match: 'git switch -C', result: '' },
    { match: 'git config', result: '' },
    { match: 'git rev-parse origin/master:packages/core', result: other },
    { match: 'git clone', result: '' },
    { match: 'git -C packages/core fetch', result: '' },
    { match: `git -C packages/core cat-file -e ${head}^{commit}`, result: '' },
    { match: `git -C packages/core merge-base --is-ancestor ${head} origin/master`, code: 1 },
  ]);
  const result = cli('update-browser-core.ts', 'prepare', {
    ...f.env,
    CORE_REPOSITORY: 'PiesP/browser-core',
    INPUT_CORE_SHA: head,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not reachable/);
  assert.equal(readFileSync(f.output, 'utf8'), '');
  assert.equal(readFileSync(f.envFile, 'utf8'), '');
});

test('publish leases the branch and verifies the generated PR head before diagnostics', () => {
  const f = fixture([
    { match: `git -C packages/core checkout --detach ${head}`, result: '' },
    { match: 'git diff --quiet -- packages/core', code: 1 },
    { match: 'git add packages/core', result: '' },
    { match: 'git commit -m', result: '' },
    { match: 'git rev-parse HEAD', result: other },
    { match: 'git diff --name-only origin/master...HEAD', result: 'packages/core' },
    {
      match: `git -c credential.helper= -c credential.https://github.com.helper=!gh auth git-credential push --set-upstream origin automation/update-browser-core --force-with-lease=refs/heads/automation/update-browser-core:${other}`,
      result: '',
    },
    { match: 'gh pr edit 12', result: '' },
    { match: 'gh pr view 12', result: JSON.stringify({ headRefOid: other }) },
    { match: 'gh workflow run', result: '' },
  ]);
  const result = cli('update-browser-core.ts', 'publish', {
    ...publicationEnv(f),
    CORE_SHA: head,
    CURRENT_CORE_SHA: other,
    REMOTE_BRANCH_SHA: other,
    OPEN_PR: '12',
    CLASSIFIED_REMOTE_BRANCH_SHA: other,
    CLASSIFIED_PR_NUMBER: '12',
    CONSUMER_IMPACT: 'true',
    PREFLIGHT: 'true',
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const pushIndex = calls.findIndex((call) => call.includes('auth git-credential push'));
  const editIndex = calls.findIndex((call) => call.includes('gh pr edit'));
  const viewIndex = calls.findIndex((call) => call.includes('gh pr view'));
  const diagnosticIndex = calls.findIndex((call) => call.includes('gh workflow run'));
  assert.ok(
    pushIndex >= 0 && pushIndex < editIndex && editIndex < viewIndex && viewIndex < diagnosticIndex
  );
  assert.equal(calls.filter((call) => call.includes('gh workflow run')).length, 2);
  assert.match(readFileSync(f.summary, 'utf8'), /- Result: update proposed/);
  assert.match(readFileSync(f.summary, 'utf8'), /- Pull request: #12/);
  assert.match(readFileSync(f.summary, 'utf8'), /- Auto-merge: not queued/);
});

test('a moved automation branch fails the push lease before PR edit', () => {
  const f = fixture([
    { match: `git -C packages/core checkout --detach ${head}`, result: '' },
    { match: 'git diff --quiet -- packages/core', code: 1 },
    { match: 'git add packages/core', result: '' },
    { match: 'git commit -m', result: '' },
    { match: 'git rev-parse HEAD', result: other },
    { match: 'git diff --name-only origin/master...HEAD', result: 'packages/core' },
    { match: 'auth git-credential push', code: 1 },
  ]);
  const result = cli('update-browser-core.ts', 'publish', {
    ...publicationEnv(f),
    CORE_SHA: head,
    CURRENT_CORE_SHA: other,
    REMOTE_BRANCH_SHA: other,
    CLASSIFIED_REMOTE_BRANCH_SHA: other,
    OPEN_PR: '12',
    CLASSIFIED_PR_NUMBER: '12',
    CONSUMER_IMPACT: 'true',
  });
  assert.notEqual(result.status, 0);
  assert.equal(
    f.calls().some((call) => call.includes('gh pr edit')),
    false
  );
  assert.equal(
    f.calls().some((call) => call.includes('gh pr create')),
    false
  );
});

test('publish fails closed when a PR head changes after the push', () => {
  const f = fixture([
    { match: `git -C packages/core checkout --detach ${head}`, result: '' },
    { match: 'git diff --quiet -- packages/core', code: 1 },
    { match: 'git add packages/core', result: '' },
    { match: 'git commit -m', result: '' },
    { match: 'git rev-parse HEAD', result: other },
    { match: 'git diff --name-only origin/master...HEAD', result: 'packages/core' },
    { match: 'auth git-credential push', result: '' },
    { match: 'gh pr edit 12', result: '' },
    { match: 'gh pr view 12', result: JSON.stringify({ headRefOid: head }) },
  ]);
  const result = cli('update-browser-core.ts', 'publish', {
    ...publicationEnv(f),
    CORE_SHA: head,
    CURRENT_CORE_SHA: other,
    OPEN_PR: '12',
    CLASSIFIED_PR_NUMBER: '12',
    CONSUMER_IMPACT: 'true',
    PREFLIGHT: 'true',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PR head changed/);
  assert.equal(
    f.calls().some((call) => call.includes('gh workflow run')),
    false
  );
});

test('prepare stops on a signaled Git operation without publishing a ready result', () => {
  const f = fixture([
    { match: 'git ls-remote --heads origin automation/update-browser-core', result: '' },
    { match: 'gh pr list', result: '[]' },
    { match: 'git fetch origin master', signal: 'SIGTERM' },
  ]);
  const result = cli('update-browser-core.ts', 'prepare', {
    ...f.env,
    CORE_REPOSITORY: 'PiesP/browser-core',
    INPUT_CORE_SHA: head,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.output, 'utf8'), '');
  assert.equal(
    f.calls().some((call) => call.includes('git switch')),
    false
  );
});

test('auto-merge queues only the exact validated head with branch protection active', () => {
  const f = fixture([{ match: 'gh pr merge', result: '' }]);
  const result = cli('dependabot-apply.ts', 'merge', {
    ...f.env,
    PR_NUMBER: '12',
    HEAD_SHA: head,
    BASE_REF: 'master',
    REASON_BASE64: Buffer.from('safe npm patch/minor set').toString('base64'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    f.calls()[0],
    `gh pr merge 12 --repo ${repository} --match-head-commit ${head} --auto --squash`
  );
});
