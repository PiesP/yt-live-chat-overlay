import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const payloads = [
  'yt-live-chat-overlay.user.js',
  'yt-live-chat-overlay.meta.js',
  'yt-live-chat-overlay-chrome.zip',
  'yt-live-chat-overlay-firefox.zip',
] as const;
const names = [...payloads, 'checksums.txt', 'metadata.json'] as const;
const shaPattern = /^[0-9a-f]{40}$/;
const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const limits: Record<string, number> = {
  'yt-live-chat-overlay.user.js': 25_000_000,
  'yt-live-chat-overlay.meta.js': 100_000,
  'yt-live-chat-overlay-chrome.zip': 100_000_000,
  'yt-live-chat-overlay-firefox.zip': 100_000_000,
  'checksums.txt': 2_000,
  'metadata.json': 10_000,
};

type Git = (args: string[]) => string;
type ReadApi = (path: string, asset?: boolean, maximumBytes?: number) => Promise<unknown>;
type ReadPrepared = (name: string) => Uint8Array;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed release or source metadata');
  return value as Record<string, unknown>;
}

function version(tag: unknown): bigint[] {
  if (typeof tag !== 'string' || !tagPattern.test(tag))
    throw new Error('Expected a canonical stable tag vX.Y.Z');
  return tag.slice(1).split('.').map(BigInt);
}

function compare(left: string, right: string): number {
  const a = version(left);
  const b = version(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0n) > (b[i] ?? 0n) ? 1 : -1;
  }
  return 0;
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`Malformed ${name} asset response`);
  if (value.length === 0 || value.length > (limits[name] ?? 0))
    throw new Error(`Invalid ${name} asset size`);
  return value;
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function checksums(data: Uint8Array): Map<string, string> {
  const lines = Buffer.from(data).toString('utf8').trimEnd().split('\n');
  if (lines.length !== payloads.length) throw new Error('Incomplete release checksums');
  const result = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([\w.-]+)$/.exec(line);
    const name = match?.[2];
    if (!name || !payloads.some((candidate) => candidate === name) || result.has(name))
      throw new Error('Malformed release checksums');
    result.set(name, match?.[1] ?? '');
  }
  if (result.size !== payloads.length) throw new Error('Incomplete release checksums');
  return result;
}

function identity(data: Uint8Array, tag: string, sha: string): void {
  const metadata = object(JSON.parse(Buffer.from(data).toString('utf8')));
  if (metadata.version !== tag.slice(1) || metadata.commit !== sha)
    throw new Error('Release metadata source or version conflicts with verified tag');
  if (
    typeof metadata.build_date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.build_date) ||
    !Number.isFinite(Date.parse(metadata.build_date)) ||
    new Date(metadata.build_date).toISOString() !== metadata.build_date ||
    typeof metadata.node_version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.node_version)
  )
    throw new Error('Release metadata build date or Node.js version is invalid');
  for (const key of ['runner_os', 'runner_arch', 'runner_image', 'runner_image_version']) {
    const value = metadata[key];
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new Error(`Release metadata ${key} is missing or invalid`);
  }
}

function verifyFiles(files: Map<string, Uint8Array>, tag: string, sha: string): void {
  identity(files.get('metadata.json') ?? new Uint8Array(), tag, sha);
  const expected = checksums(files.get('checksums.txt') ?? new Uint8Array());
  for (const name of payloads) {
    const content = files.get(name);
    if (!content || digest(content) !== expected.get(name))
      throw new Error(`Release asset integrity failed: ${name}`);
  }
}

export async function verifyPublication(
  tag: string,
  sha: string,
  workflowSha: string,
  git: Git,
  readApi: ReadApi,
  readPrepared: ReadPrepared
): Promise<{ publish: boolean }> {
  version(tag);
  if (!shaPattern.test(sha) || !shaPattern.test(workflowSha))
    throw new Error('Release and workflow sources must be full commit SHAs');
  if (git(['rev-parse', 'HEAD']) !== workflowSha)
    throw new Error('Publication guard must execute from protected workflow source');
  // Explicit remote ref fetch fails if the tag was deleted. Force only updates this local checkout.
  git(['fetch', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  if (git(['rev-parse', '--verify', `${tag}^{commit}`]) !== sha)
    throw new Error('Release tag identity changed after validation');
  git(['merge-base', '--is-ancestor', sha, workflowSha]);
  const manifest = object(JSON.parse(git(['show', `${sha}:package.json`])));
  if (manifest.version !== tag.slice(1)) throw new Error('Tag and source version differ');
  const prepared = new Map<string, Uint8Array>();
  for (const name of names) prepared.set(name, bytes(readPrepared(name), name));
  verifyFiles(prepared, tag, sha);
  const notes = readPrepared('RELEASE_NOTES.md');
  if (!(notes instanceof Uint8Array) || notes.length === 0 || notes.length > 100_000)
    throw new Error('Release notes are missing or invalid');
  if (!Buffer.from(notes).toString('utf8').startsWith(`# Release ${tag}\n`))
    throw new Error('Release notes version differs');

  const latestValue = await readApi('/releases/latest');
  const targetValue = await readApi(`/releases/tags/${tag}`);
  if (latestValue === null && targetValue !== null)
    throw new Error('Latest release state conflicts with requested release');
  if (latestValue !== null) {
    const latest = object(latestValue);
    if (latest.draft !== false || latest.prerelease !== false)
      throw new Error('Malformed latest release state');
    version(latest.tag_name);
    if (compare(tag, latest.tag_name as string) < 0)
      throw new Error('Refusing release channel rollback');
  }
  if (targetValue === null) return { publish: true };
  const target = object(targetValue);
  if (
    target.tag_name !== tag ||
    target.draft !== false ||
    target.prerelease !== false ||
    object(latestValue).tag_name !== tag ||
    !Array.isArray(target.assets)
  )
    throw new Error('Conflicting existing release requires maintainer review');
  if (target.assets.length !== names.length)
    throw new Error('Existing release has incomplete or unexpected assets');
  const assets = new Map<string, Record<string, unknown>>();
  for (const raw of target.assets) {
    const asset = object(raw);
    if (
      typeof asset.name !== 'string' ||
      !names.some((name) => name === asset.name) ||
      assets.has(asset.name) ||
      !Number.isSafeInteger(asset.id) ||
      Number(asset.id) <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      Number(asset.size) <= 0 ||
      Number(asset.size) > (limits[asset.name] ?? 0) ||
      asset.state !== 'uploaded'
    )
      throw new Error('Existing release asset is incomplete or malformed');
    assets.set(asset.name, asset);
  }
  const existing = new Map<string, Uint8Array>();
  for (const name of names) {
    const asset = assets.get(name);
    if (!asset) throw new Error(`Existing release is missing ${name}`);
    const content = bytes(await readApi(`/releases/assets/${asset.id}`, true, limits[name]), name);
    if (
      content.length !== asset.size ||
      (asset.digest !== undefined && asset.digest !== `sha256:${digest(content)}`)
    )
      throw new Error(`Existing release asset integrity failed: ${name}`);
    existing.set(name, content);
  }
  verifyFiles(existing, tag, sha);
  return { publish: false };
}

function directInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (directInvocation()) {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GITHUB_TOKEN;
  const output = process.env.GITHUB_OUTPUT;
  const tag = process.env.RELEASE_TAG ?? '';
  if (repository !== 'PiesP/yt-live-chat-overlay' || !token || !output)
    throw new Error('Expected repository, token and output are required');
  try {
    const result = await verifyPublication(
      tag,
      process.env.RELEASE_SHA ?? '',
      process.env.GITHUB_SHA ?? '',
      (args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
      async (path, asset, maximumBytes) => {
        const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 404 && !asset) return null;
        if (!response.ok) throw new Error(`GitHub release query failed: HTTP ${response.status}`);
        if (asset) {
          if (!response.body || maximumBytes === undefined)
            throw new Error('Asset stream unavailable');
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > maximumBytes) throw new Error('Existing release asset exceeds size limit');
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        }
        return response.json() as Promise<unknown>;
      },
      (name) => readFileSync(join('release-bundle', 'release', name))
    );
    appendFileSync(output, `publish=${result.publish}\n`);
    console.log(
      result.publish
        ? `Publication approved for ${tag}`
        : `Complete ${tag} release verified; no write needed`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
