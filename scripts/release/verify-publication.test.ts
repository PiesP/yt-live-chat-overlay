import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyPublication } from './verify-publication.ts';

const sha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const tag = 'v1.2.3';
const buildMetadata = {
  version: '1.2.3',
  commit: sha,
  build_date: '2026-10-07T05:00:00.000Z',
  node_version: '26.9.0',
  runner_os: 'linux',
  runner_arch: 'x64',
  runner_image: 'unknown',
  runner_image_version: 'unknown',
};
const payloads = [
  'yt-live-chat-overlay.user.js',
  'yt-live-chat-overlay.meta.js',
  'yt-live-chat-overlay-chrome.zip',
  'yt-live-chat-overlay-firefox.zip',
];

function fixture(releaseTag = tag, nodeVersion = buildMetadata.node_version) {
  const files = new Map<string, Uint8Array>();
  for (const name of payloads) files.set(name, Buffer.from(`release payload ${name}`));
  files.set(
    'checksums.txt',
    Buffer.from(
      `${payloads
        .map(
          (name) =>
            `${createHash('sha256')
              .update(files.get(name) ?? new Uint8Array())
              .digest('hex')}  ${name}`
        )
        .join('\n')}\n`
    )
  );
  files.set(
    'metadata.json',
    Buffer.from(
      JSON.stringify({ ...buildMetadata, version: releaseTag.slice(1), node_version: nodeVersion })
    )
  );
  files.set('RELEASE_NOTES.md', Buffer.from(`# Release ${releaseTag}\n\nNotes`));
  const assets = [...files]
    .filter(([name]) => name !== 'RELEASE_NOTES.md')
    .map(([name, content], index) => ({
      id: index + 1,
      name,
      size: content.length,
      state: 'uploaded',
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    }));
  const existing = { tag_name: releaseTag, draft: false, prerelease: false, assets };
  const api = new Map<string, unknown>([
    ['/releases/latest', { tag_name: 'v1.2.2', draft: false, prerelease: false }],
    [`/releases/tags/${releaseTag}`, null],
  ]);
  for (const asset of assets) api.set(`/releases/assets/${asset.id}`, files.get(asset.name));
  const gitCalls: string[][] = [];
  const git = (args: string[]): string => {
    gitCalls.push(args);
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? workflowSha : sha;
    if (args[0] === 'show') return JSON.stringify({ version: releaseTag.slice(1) });
    return '';
  };
  const readApi = async (path: string): Promise<unknown> => {
    if (!api.has(path)) throw new Error(`Unexpected API path ${path}`);
    return api.get(path);
  };
  const run = () =>
    verifyPublication(releaseTag, sha, workflowSha, git, readApi, (name) => {
      const file = files.get(name);
      if (!file) throw new Error(`Missing prepared file: ${name}`);
      return file;
    });
  return { files, assets, existing, api, gitCalls, run };
}

test('new release passes only after source, prepared assets and rollback checks', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { publish: true });
  assert.ok(
    f.gitCalls.some(
      (args) => args[0] === 'fetch' && args[3] === `refs/tags/${tag}:refs/tags/${tag}`
    )
  );
  assert.ok(f.gitCalls.some((args) => args[0] === 'merge-base'));
});

test('complete existing release verifies its own bytes and makes no writes', async () => {
  const f = fixture();
  f.api.set('/releases/latest', f.existing);
  f.api.set(`/releases/tags/${tag}`, f.existing);
  f.files.set('yt-live-chat-overlay-chrome.zip', Buffer.from('a different rebuild'));
  f.files.set(
    'checksums.txt',
    Buffer.from(
      `${payloads
        .map(
          (name) =>
            `${createHash('sha256')
              .update(f.files.get(name) ?? new Uint8Array())
              .digest('hex')}  ${name}`
        )
        .join('\n')}\n`
    )
  );
  assert.deepEqual(await f.run(), { publish: false });
});

test('missing, extra and corrupt existing assets fail closed', async () => {
  for (const mutation of ['missing', 'extra', 'corrupt', 'wrong-size', 'bad-checksums']) {
    const f = fixture();
    f.api.set('/releases/latest', f.existing);
    f.api.set(`/releases/tags/${tag}`, f.existing);
    if (mutation === 'missing') f.existing.assets.pop();
    if (mutation === 'extra')
      f.existing.assets.push({
        id: 99,
        name: 'unexpected.zip',
        size: 2,
        state: 'uploaded',
        digest: 'sha256:x',
      });
    if (mutation === 'corrupt')
      f.api.set('/releases/assets/1', Buffer.from('x'.repeat(f.assets[0]?.size ?? 10)));
    if (mutation === 'wrong-size' && f.assets[0]) f.assets[0].size += 1;
    if (mutation === 'bad-checksums') f.api.set('/releases/assets/5', Buffer.from('invalid'));
    await assert.rejects(f.run(), { name: 'Error' }, mutation);
  }
});

test('prepared and existing metadata require complete valid build runtime fields', async () => {
  for (const location of ['prepared', 'existing']) {
    for (const [field, invalid] of [
      ['build_date', '2026-02-30T05:00:00.000Z'],
      ['node_version', 'unknown'],
      ['runner_os', ''],
      ['runner_arch', null],
      ['runner_image', 1],
      ['runner_image_version', '   '],
    ] as const) {
      for (const omit of [true, false]) {
        const f = fixture();
        const metadata: Record<string, unknown> = { ...buildMetadata };
        if (omit) delete metadata[field];
        else metadata[field] = invalid;
        const content = Buffer.from(JSON.stringify(metadata));
        if (location === 'prepared') f.files.set('metadata.json', content);
        else {
          f.api.set('/releases/latest', f.existing);
          f.api.set(`/releases/tags/${tag}`, f.existing);
          f.api.set('/releases/assets/6', content);
          const asset = f.assets[5];
          assert.ok(asset);
          asset.size = content.length;
          asset.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
        }
        await assert.rejects(f.run(), { name: 'Error' }, `${location}: ${field} omitted=${omit}`);
      }
    }
  }
});

test('existing build runtime differences do not trigger writes', async () => {
  const f = fixture();
  f.api.set('/releases/latest', f.existing);
  f.api.set(`/releases/tags/${tag}`, f.existing);
  f.files.set(
    'metadata.json',
    Buffer.from(
      JSON.stringify({
        ...buildMetadata,
        build_date: '2026-10-07T06:00:00.000Z',
        node_version: '22.22.0',
      })
    )
  );
  assert.deepEqual(await f.run(), { publish: false });
});

test('published v0.45.2 metadata keeps its historical Node runtime contract on a no-op retry', async () => {
  for (const legacyNodeVersion of ['26', 'unknown', '26.9.0']) {
    const f = fixture('v0.45.2', legacyNodeVersion);
    f.api.set('/releases/latest', f.existing);
    f.api.set('/releases/tags/v0.45.2', f.existing);
    assert.deepEqual(await f.run(), { publish: false });
  }
});

test('legacy Node runtime forms still require the other recorded build fields', async () => {
  for (const location of ['prepared', 'existing']) {
    const f = fixture('v0.45.2', '26');
    const metadata = { ...buildMetadata, version: '0.45.2', node_version: '26' } as Record<
      string,
      unknown
    >;
    delete metadata.runner_image;
    const content = Buffer.from(JSON.stringify(metadata));
    if (location === 'prepared') f.files.set('metadata.json', content);
    else {
      f.api.set('/releases/latest', f.existing);
      f.api.set('/releases/tags/v0.45.2', f.existing);
      f.api.set('/releases/assets/6', content);
      const asset = f.assets[5];
      assert.ok(asset);
      asset.size = content.length;
      asset.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    }
    await assert.rejects(f.run(), /runner_image/, location);
  }
});

test('v0.45.3 and later reject historical major-only or unknown Node runtimes', async () => {
  for (const releaseTag of ['v0.45.3', 'v1.2.3']) {
    for (const legacyNodeVersion of ['26', 'unknown', undefined]) {
      for (const location of ['prepared', 'existing']) {
        const f = fixture(releaseTag);
        const metadata: Record<string, unknown> = {
          ...buildMetadata,
          version: releaseTag.slice(1),
        };
        if (legacyNodeVersion === undefined) delete metadata.node_version;
        else metadata.node_version = legacyNodeVersion;
        const content = Buffer.from(JSON.stringify(metadata));
        if (location === 'prepared') f.files.set('metadata.json', content);
        else {
          f.api.set('/releases/latest', f.existing);
          f.api.set(`/releases/tags/${releaseTag}`, f.existing);
          f.api.set('/releases/assets/6', content);
          const asset = f.assets[5];
          assert.ok(asset);
          asset.size = content.length;
          asset.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
        }
        await assert.rejects(f.run(), /Node\.js version is invalid/, `${releaseTag}: ${location}`);
      }
    }
  }
});

test('conflicting source/version and malformed release response fail closed', async () => {
  for (const change of ['source', 'version', 'malformed', 'draft']) {
    const f = fixture();
    f.api.set('/releases/latest', f.existing);
    f.api.set(`/releases/tags/${tag}`, f.existing);
    if (change === 'source' || change === 'version') {
      const content = Buffer.from(
        JSON.stringify({
          version: change === 'version' ? '1.2.2' : '1.2.3',
          commit: change === 'source' ? workflowSha : sha,
        })
      );
      f.api.set('/releases/assets/6', content);
      if (f.assets[5]) {
        f.assets[5].size = content.length;
        f.assets[5].digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      }
    }
    if (change === 'malformed') f.api.set(`/releases/tags/${tag}`, { assets: [] });
    if (change === 'draft') f.existing.draft = true;
    await assert.rejects(f.run(), { name: 'Error' }, change);
  }
});

test('moved/deleted tag, rollback and GitHub errors fail closed', async () => {
  const moved = fixture();
  const original = moved.gitCalls;
  await assert.rejects(
    verifyPublication(
      tag,
      sha,
      workflowSha,
      (args) => {
        original.push(args);
        if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? workflowSha : 'c'.repeat(40);
        return '';
      },
      async () => null,
      (name) => moved.files.get(name) ?? new Uint8Array()
    ),
    /identity changed/
  );
  const deleted = fixture();
  await assert.rejects(
    verifyPublication(
      tag,
      sha,
      workflowSha,
      (args) => {
        if (args[0] === 'fetch') throw new Error('remote tag missing');
        return args[0] === 'rev-parse' ? workflowSha : '';
      },
      async () => null,
      (name) => deleted.files.get(name) ?? new Uint8Array()
    ),
    /remote tag missing/
  );
  const rollback = fixture();
  rollback.api.set('/releases/latest', { tag_name: 'v1.2.4', draft: false, prerelease: false });
  await assert.rejects(rollback.run(), /rollback/);
  const failed = fixture();
  await assert.rejects(
    verifyPublication(
      tag,
      sha,
      workflowSha,
      (args) => {
        if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? workflowSha : sha;
        if (args[0] === 'show') return JSON.stringify({ version: '1.2.3' });
        return '';
      },
      async () => {
        throw new Error('API unavailable');
      },
      (name) => failed.files.get(name) ?? new Uint8Array()
    ),
    /API unavailable/
  );
  const malformed = fixture();
  malformed.api.set('/releases/latest', []);
  await assert.rejects(malformed.run(), /Malformed/);
});

test('missing prepared file or conflicting prepared identity fails before API read', async () => {
  for (const mutation of ['missing', 'identity']) {
    const f = fixture();
    if (mutation === 'missing') f.files.delete('yt-live-chat-overlay-firefox.zip');
    else
      f.files.set('metadata.json', Buffer.from(JSON.stringify({ version: '1.2.2', commit: sha })));
    await assert.rejects(f.run(), { name: 'Error' }, mutation);
  }
});

test('write-capable workflow runs the trusted guard before a conditional non-overwriting action', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/release.yaml', import.meta.url),
    'utf8'
  );
  const publish = workflow.split('  publish:\n')[1] ?? '';
  const checkout = publish.indexOf('name: 📥 Checkout protected publication guard');
  const runtime = publish.indexOf('name: 📦 Set up trusted publication runtime');
  const guard = publish.indexOf(
    'run: node --experimental-strip-types scripts/release/verify-publication.ts'
  );
  const action = publish.indexOf('uses: softprops/action-gh-release@');
  assert.ok(checkout >= 0 && checkout < runtime && runtime < guard && guard < action);
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /persist-credentials: false/);
  assert.match(publish, /install-dependencies: 'false'/);
  assert.match(publish, /if: \$\{\{ steps\.guard\.outputs\.publish == 'true' \}\}/);
  assert.match(publish, /overwrite_files: false/);
  assert.match(publish, /fail_on_unmatched_files: true/);
  assert.match(publish, /group: release-publish/);
});
