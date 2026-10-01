import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const hooks = resolve(import.meta.dirname, '../../../.githooks');

function run(cwd: string, ...args: string[]) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, ...args);
  expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yt-git-hooks-'));
  const work = join(directory, 'work');
  mkdirSync(work);
  git(work, 'init', '-b', 'master', '-q');
  git(work, 'config', 'user.name', 'Fixture');
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(work, 'base.txt'), 'base\n');
  git(work, 'add', 'base.txt');
  git(work, 'commit', '-m', 'Initial fixture commit');
  return { directory, work };
}

describe('protected Git hook path', () => {
  it('rejects default and detached commits, including an in-progress merge, but allows topic commits', () => {
    const { directory, work } = fixture();
    try {
      git(work, 'switch', '-c', 'topic');
      writeFileSync(join(work, 'topic.txt'), 'topic\n');
      git(work, 'add', 'topic.txt');
      git(work, 'commit', '-m', 'Topic fixture commit');
      git(work, 'switch', 'master');
      writeFileSync(join(work, 'master.txt'), 'master\n');
      git(work, 'add', 'master.txt');
      git(work, 'commit', '-m', 'Master fixture commit');
      git(work, 'config', 'core.hooksPath', hooks);

      writeFileSync(join(work, 'direct.txt'), 'direct\n');
      git(work, 'add', 'direct.txt');
      expect(run(work, 'commit', '-m', 'Blocked default commit').status).not.toBe(0);
      git(work, 'reset', '--hard', 'HEAD');

      git(work, 'merge', '--no-ff', '--no-commit', 'topic');
      expect(existsSync(join(work, '.git', 'MERGE_HEAD'))).toBe(true);
      expect(run(work, 'commit', '-m', 'Blocked merge commit').status).not.toBe(0);
      git(work, 'merge', '--abort');

      git(work, 'switch', 'topic');
      writeFileSync(join(work, 'second.txt'), 'topic again\n');
      git(work, 'add', 'second.txt');
      expect(run(work, 'commit', '-m', 'Allowed topic commit').status).toBe(0);

      git(work, 'switch', '-c', 'main');
      writeFileSync(join(work, 'main.txt'), 'main\n');
      git(work, 'add', 'main.txt');
      expect(run(work, 'commit', '-m', 'Blocked main commit').status).not.toBe(0);
      git(work, 'reset', '--hard', 'HEAD');

      git(work, 'switch', '--detach');
      writeFileSync(join(work, 'detached.txt'), 'detached\n');
      git(work, 'add', 'detached.txt');
      expect(run(work, 'commit', '-m', 'Blocked detached commit').status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects default pushes and deletion even for a no-ff merge, while allowing a topic push', () => {
    const { directory, work } = fixture();
    try {
      git(work, 'switch', '-c', 'topic');
      writeFileSync(join(work, 'topic.txt'), 'topic\n');
      git(work, 'add', 'topic.txt');
      git(work, 'commit', '-m', 'Topic fixture commit');
      git(work, 'switch', 'master');
      writeFileSync(join(work, 'master.txt'), 'master\n');
      git(work, 'add', 'master.txt');
      git(work, 'commit', '-m', 'Master fixture commit');
      const remoteBase = git(work, 'rev-parse', 'HEAD');
      git(work, 'merge', '--no-ff', '-m', 'Merge topic fixture', 'topic');

      const remote = join(directory, 'remote.git');
      git(directory, 'init', '--bare', '-q', remote);
      git(work, 'remote', 'add', 'origin', remote);
      git(work, 'push', 'origin', `${remoteBase}:refs/heads/master`);
      git(work, 'config', 'core.hooksPath', hooks);

      expect(run(work, 'push', 'origin', 'master').status).not.toBe(0);
      expect(run(work, 'push', 'origin', ':master').status).not.toBe(0);
      expect(git(directory, '--git-dir', remote, 'rev-parse', 'refs/heads/master')).toBe(remoteBase);
      expect(run(work, 'push', 'origin', 'topic:main').status).not.toBe(0);
      expect(run(work, 'push', 'origin', 'topic').status).toBe(0);
      expect(git(directory, '--git-dir', remote, 'rev-parse', 'refs/heads/topic')).toBe(
        git(work, 'rev-parse', 'topic')
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
