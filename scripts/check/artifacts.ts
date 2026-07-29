// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface ExtensionManifest {
  content_scripts?: Array<{ js?: string[] }>;
  background?: { service_worker?: string; scripts?: string[] };
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

  for (const script of ['content-script.js', 'page-script.js']) {
    const source = readFileSync(join(directory, script), 'utf8');
    if (!source.trimStart().startsWith('(function(') || /^\s*(?:import|export)\s/m.test(source)) {
      throw new Error(`${relativeDirectory}/${script} is not a self-contained IIFE bundle.`);
    }
  }
}

if (process.argv.includes('--e2e')) {
  assertExists(root, 'dist/yt-live-chat-overlay.dev.user.js');
  checkExtension('dist-extension');
} else {
  checkExtension('dist-extension');
  checkExtension('dist-extension-firefox');
}
console.log('Build artifact references are valid.');
