#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCOPES = [
  'all',
  'quality',
  'unit',
  'core',
  'e2e',
  'build',
  'duplication',
  'osv',
  'semgrep',
  'codeql_actions',
  'codeql_javascript',
  'pinned_tools',
  'deep_fast',
] as const;
type Scope = (typeof SCOPES)[number];
type Decision = ReadonlySet<Scope>;
type Environment = Record<string, string | undefined>;

const fastMutationExclusions = new Set([
  'src/main.ts',
  'src/app/chat-availability-preflight.ts',
  'src/app/overlay.ts',
  'src/app/runtime-manager.ts',
  'src/app/standby-controller.ts',
  'src/app/video-pause-controller.ts',
  'src/media/image-fetch-manager.ts',
  'src/platform/menu-adapters.ts',
  'src/platform/storage-adapters.ts',
  'src/platform/worker-factory.ts',
  'src/settings/store.ts',
  'src/settings/ui/controller.ts',
  'src/settings/ui/form.ts',
  'src/settings/ui/panes.ts',
  'src/settings/ui/styles.ts',
  'src/translation/service.ts',
  'src/translation/language-detector.ts',
  'src/util/backlog-indicator.ts',
  'src/util/backlog-sampler.ts',
  'src/util/observability.ts',
]);

function isFastMutationSource(path: string): boolean {
  return (
    path.startsWith('src/') &&
    path.endsWith('.ts') &&
    !path.endsWith('.d.ts') &&
    !path.startsWith('src/types/') &&
    !path.startsWith('src/renderer/') &&
    !path.startsWith('src/chat/') &&
    !fastMutationExclusions.has(path)
  );
}

function gitSucceeded(cwd: string, ...args: string[]): boolean {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore' });
  return result.status === 0 && !result.error;
}

export function classifyWorkflowChanges(
  args: readonly string[],
  env: Environment = process.env,
  cwd = process.cwd()
): Decision {
  const selected = new Set<Scope>();
  const mark = (...scopes: Scope[]): void => {
    for (const scope of scopes) selected.add(scope);
  };
  const markAll = (): void => mark(...SCOPES);

  function classifyPath(path: string): void {
    if (path === 'scripts/ci/classify-workflow-changes.ts') {
      markAll();
    } else if (
      [
        'packages/core',
        '.gitmodules',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
      ].includes(path)
    ) {
      mark(
        'quality',
        'unit',
        'core',
        'e2e',
        'build',
        'osv',
        'semgrep',
        'codeql_javascript',
        'pinned_tools',
        'deep_fast'
      );
    } else if (path.startsWith('src/')) {
      mark('quality', 'unit', 'e2e', 'build', 'duplication', 'semgrep', 'codeql_javascript');
      if (isFastMutationSource(path)) mark('deep_fast');
    } else if (path.startsWith('extension/icons/')) {
      mark('e2e', 'build');
    } else if (path.startsWith('extension/') && path.endsWith('.ts')) {
      mark('quality', 'unit', 'e2e', 'build', 'semgrep', 'codeql_javascript');
    } else if (path.startsWith('extension/') && path.endsWith('.json')) {
      mark('quality', 'unit', 'e2e', 'build', 'semgrep');
    } else if (
      path.startsWith('tooling/') ||
      path === 'vite.config.ts' ||
      /^vite\.config\..*\.ts$/.test(path)
    ) {
      mark('quality', 'unit', 'e2e', 'build', 'semgrep', 'codeql_javascript');
    } else if (path.startsWith('validation/windows/')) {
      mark('quality', 'unit', 'semgrep', 'codeql_javascript');
    } else if (path.startsWith('test/e2e/')) {
      mark('quality', 'e2e', 'semgrep', 'codeql_javascript');
    } else if (
      path.startsWith('test/unit/') ||
      path.startsWith('test/consistency/') ||
      path === 'test/setup.ts'
    ) {
      mark('quality', 'unit', 'semgrep', 'codeql_javascript', 'deep_fast');
    } else if (path.startsWith('test/visual/')) {
      mark('semgrep', 'codeql_javascript');
    } else if (path === 'nose.toml' || path === '.nose-baseline.json') {
      mark('quality', 'duplication', 'semgrep');
    } else if (
      ['biome.json', 'knip.json', 'vitest.config.ts'].includes(path) ||
      /^tsconfig.*\.json$/.test(path) ||
      /^stryker\.conf.*\.json$/.test(path)
    ) {
      mark('quality', 'unit', 'e2e', 'build', 'semgrep', 'codeql_javascript', 'deep_fast');
    } else if (path.startsWith('scripts/')) {
      mark('quality', 'unit', 'build', 'semgrep', 'codeql_javascript');
      if (path.startsWith('scripts/ci/')) {
        mark('pinned_tools');
        if (
          [
            'scripts/ci/install-nose.ts',
            'scripts/ci/install-nose.sh',
            'scripts/ci/pinned-tools.json',
            'scripts/ci/pinned-tools.ts',
          ].includes(path)
        ) {
          mark('duplication');
        }
        if (path === 'scripts/ci/pinned-tools.json' || path === 'scripts/ci/pinned-tools.ts') {
          mark('osv');
        }
      }
    } else if (path === '.github/workflows/ci.yaml') {
      mark(
        'quality',
        'unit',
        'core',
        'e2e',
        'build',
        'duplication',
        'semgrep',
        'codeql_actions',
        'pinned_tools'
      );
    } else if (path === '.github/workflows/security.yaml') {
      mark('quality', 'unit', 'osv', 'semgrep', 'codeql_actions', 'pinned_tools');
    } else if (path === '.github/workflows/deep-checks.yaml') {
      mark('quality', 'unit', 'semgrep', 'codeql_actions', 'pinned_tools', 'deep_fast');
    } else if (path === '.github/workflows/release.yaml') {
      mark(
        'quality',
        'unit',
        'e2e',
        'build',
        'duplication',
        'semgrep',
        'codeql_actions',
        'pinned_tools'
      );
    } else if (path.startsWith('.github/workflows/')) {
      mark('quality', 'unit', 'semgrep', 'codeql_actions', 'pinned_tools');
    } else if (path.startsWith('.github/actions/')) {
      mark('quality', 'unit', 'build', 'semgrep', 'codeql_actions', 'pinned_tools');
    } else if (path === '.github/settings.yml') {
      mark('quality', 'unit', 'semgrep', 'codeql_actions');
    } else if (
      ['.github/SECURITY.md', '.github/threat-model.md', 'PRIVACY.md'].includes(path) ||
      path.startsWith('.githooks/')
    ) {
      mark('semgrep');
    } else if (
      [
        'README.md',
        'CHANGELOG.md',
        'CODE_OF_CONDUCT.md',
        'CONTRIBUTING.md',
        'LICENSE',
        'SUPPORT.md',
        'extension/README.md',
        '.github/pull_request_template.md',
        '.github/CODEOWNERS',
        '.github/dependabot.yaml',
        '.gitignore',
        '.gitattributes',
        'test/.gitignore',
      ].includes(path) ||
      path.startsWith('docs/') ||
      path.startsWith('.github/ISSUE_TEMPLATE/')
    ) {
      mark('semgrep');
    } else {
      process.stderr.write(`Unknown workflow path; enabling every scope: ${path}\n`);
      markAll();
    }
  }

  if (args[0] === '--paths') {
    for (const path of args.slice(1)) classifyPath(path);
    return selected;
  }

  const event = env.EVENT_NAME ?? '';
  if (event === 'workflow_dispatch' || event === 'schedule') {
    process.stderr.write(`${event} requests complete verification.\n`);
    markAll();
    return selected;
  }
  if (!['pull_request', 'merge_group', 'push'].includes(event)) {
    process.stderr.write(`Unknown workflow event; enabling every scope: ${event || '<empty>'}\n`);
    markAll();
    return selected;
  }

  const base = env.BASE_SHA ?? '';
  const head = env.HEAD_SHA ?? '';
  if (event === 'push' && /^0{40}$/.test(base)) {
    process.stderr.write('Push has no usable base revision; enabling every scope.\n');
    markAll();
    return selected;
  }
  if (
    !/^[0-9a-f]{40}$/.test(base) ||
    !/^[0-9a-f]{40}$/.test(head) ||
    !gitSucceeded(cwd, 'cat-file', '-e', `${base}^{commit}`) ||
    !gitSucceeded(cwd, 'cat-file', '-e', `${head}^{commit}`)
  ) {
    process.stderr.write('Workflow revisions are unavailable; enabling every scope.\n');
    markAll();
    return selected;
  }

  const range = `${base}${event === 'push' ? '..' : '...'}${head}`;
  const diff = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', range, '--'], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (diff.status !== 0 || diff.error || !diff.stdout) {
    process.stderr.write('Unable to calculate workflow diff; enabling every scope.\n');
    markAll();
    return selected;
  }
  const bytes = diff.stdout as Buffer;
  if (bytes.length === 0) {
    process.stderr.write('Workflow diff is empty; enabling every scope.\n');
    markAll();
    return selected;
  }
  if (bytes.at(-1) !== 0) {
    process.stderr.write('Invalid workflow diff output; enabling every scope.\n');
    markAll();
    return selected;
  }
  try {
    const paths = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\0');
    for (const path of paths) classifyPath(path);
  } catch {
    process.stderr.write('Invalid workflow diff output; enabling every scope.\n');
    markAll();
  }
  return selected;
}

function emit(scopes: Decision, env: Environment): void {
  const body = `${SCOPES.map((scope) => `${scope}=${scopes.has(scope)}`).join('\n')}\n`;
  process.stdout.write(body);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, body);
}

// Resolving both sides keeps a symlink to the CLI executable while imports stay inert.
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  emit(classifyWorkflowChanges(process.argv.slice(2)), process.env);
}
