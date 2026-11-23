// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { MAX_PACKAGED_WORKER_BYTES } from '../../extension/worker-source-limit.ts';
import {
  assertDistributionNotice,
  assertNoticeFile,
  DISTRIBUTION_NOTICE_BANNER,
  NOTICE_FILES,
} from '../../tooling/vite/distribution-notices.ts';
import { assertFirefoxDataConsent } from './firefox-manifest.ts';

export { assertDistributionNotice };

interface ExtensionManifest {
  content_scripts?: Array<{ js?: string[]; world?: string }>;
  background?: { service_worker?: string; scripts?: string[] };
  permissions?: string[];
  web_accessible_resources?: Array<{ resources?: string[] }>;
}

const root = resolve(import.meta.dirname, '..', '..');
function assertExists(base: string, relativePath: string): void {
  if (!existsSync(join(base, relativePath))) {
    throw new Error(`Missing artifact: ${base}/${relativePath}`);
  }
}

function assertGlobHasMatch(base: string, pattern: string): void {
  const slash = pattern.lastIndexOf('/');
  const directory = slash >= 0 ? pattern.slice(0, slash) : '';
  const filePattern = slash >= 0 ? pattern.slice(slash + 1) : pattern;
  const escapedParts = filePattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`^${escapedParts.join('.*')}$`);
  const entries = readdirSync(join(base, directory), { withFileTypes: true });
  if (!entries.some((entry) => entry.isFile() && regex.test(entry.name))) {
    throw new Error(`No artifact matches ${base}/${pattern}`);
  }
}

export function assertPackagedWorkerSource(file: string): number {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Missing packaged worker source: ${file}`);
    }
    throw error;
  }
  let source: Buffer;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Packaged worker source is not a regular file: ${file}`);
    }
    source = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const size = source.length;
  if (size === 0) throw new Error(`Packaged worker source is empty: ${file}`);
  if (size > MAX_PACKAGED_WORKER_BYTES) {
    throw new Error(
      `Packaged worker source exceeds ${MAX_PACKAGED_WORKER_BYTES} UTF-8 bytes: ${file} (${size})`
    );
  }
  // The runtime measures the decoded source when creating its Blob.
  new TextDecoder('utf-8', { fatal: true }).decode(source);
  return size;
}

function checkExtension(relativeDirectory: string): void {
  const directory = join(root, relativeDirectory);
  const manifestPath = join(directory, 'manifest.json');
  assertExists(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

  for (const script of manifest.content_scripts?.flatMap((entry) => entry.js ?? []) ?? []) {
    assertExists(directory, script);
  }
  if (manifest.background?.service_worker) {
    assertExists(directory, manifest.background.service_worker);
  }
  for (const script of manifest.background?.scripts ?? []) {
    assertExists(directory, script);
  }
  for (const resource of manifest.web_accessible_resources?.flatMap(
    (entry) => entry.resources ?? []
  ) ?? []) {
    if (resource.includes('*')) assertGlobHasMatch(directory, resource);
    else assertExists(directory, resource);
  }

  for (const file of NOTICE_FILES) {
    assertNoticeFile(readFileSync(join(directory, file)), file, relativeDirectory);
  }
  for (const script of ['content-script.js', 'page-script.js']) {
    const source = readFileSync(join(directory, script), 'utf8');
    let executableSource = source.trimStart();
    if (script === 'page-script.js') {
      if (!executableSource.startsWith(DISTRIBUTION_NOTICE_BANNER)) {
        throw new Error(
          `${relativeDirectory}/${script} must place the distribution notices before its IIFE.`
        );
      }
      executableSource = executableSource.slice(DISTRIBUTION_NOTICE_BANNER.length).trimStart();
    }
    if (
      !executableSource.startsWith('(function(') ||
      /^\s*(?:import|export)\s/m.test(executableSource)
    ) {
      throw new Error(`${relativeDirectory}/${script} is not a self-contained IIFE bundle.`);
    }
  }
}

function checkFirefoxContract(): void {
  const relativeDirectory = 'dist-extension-firefox';
  const directory = join(root, relativeDirectory);
  const manifest = JSON.parse(
    readFileSync(join(directory, 'manifest.json'), 'utf8')
  ) as ExtensionManifest;
  assertFirefoxDataConsent(manifest, `${relativeDirectory}/manifest.json`);
  if (!manifest.permissions?.includes('storage') || !manifest.permissions.includes('menus')) {
    throw new Error(`${relativeDirectory}/manifest.json is missing Firefox runtime permissions.`);
  }
  if (
    manifest.background?.service_worker ||
    !manifest.background?.scripts?.includes('background.js')
  ) {
    throw new Error(
      `${relativeDirectory}/manifest.json must use the Firefox background scripts contract.`
    );
  }
  if (
    !manifest.content_scripts?.length ||
    manifest.content_scripts.some((entry) => entry.world !== 'ISOLATED')
  ) {
    throw new Error(`${relativeDirectory}/manifest.json must isolate every content script.`);
  }
  const resources = new Set(
    manifest.web_accessible_resources?.flatMap((entry) => entry.resources ?? []) ?? []
  );
  if (!resources.has('page-script.js') || !resources.has('workers/*.js')) {
    throw new Error(`${relativeDirectory}/manifest.json is missing Firefox page/worker resources.`);
  }
}

export function checkArtifacts(args: readonly string[] = process.argv): void {
  for (const option of args.slice(2)) {
    if (option !== '--e2e') {
      throw new Error(
        `Unsupported artifact-check option: ${option}; use the all-target build to record a footprint`
      );
    }
  }
  if (args.includes('--e2e')) {
    assertExists(root, 'dist/yt-live-chat-overlay.dev.user.js');
  } else {
    const userscript = readFileSync(join(root, 'dist/yt-live-chat-overlay.user.js'), 'utf8');
    if (!userscript.startsWith('// ==UserScript==')) {
      throw new Error(
        'Production userscript metadata must remain the first bytes of the artifact.'
      );
    }
    assertDistributionNotice(userscript, 'dist/yt-live-chat-overlay.user.js');
  }
  checkExtension('dist-extension');
  checkExtension('dist-extension-firefox');
  checkFirefoxContract();
  for (const directory of ['dist-extension', 'dist-extension-firefox']) {
    const worker = join(directory, 'workers/renderer.js');
    assertPackagedWorkerSource(join(root, worker));
    assertDistributionNotice(readFileSync(join(root, worker), 'utf8'), worker);
  }
  console.log('Build artifact references are valid.');
}

if (import.meta.main) checkArtifacts();
