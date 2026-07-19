// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ExtensionManifest {
  content_scripts?: Array<{ js?: string[] }>;
  background?: { service_worker?: string; scripts?: string[] };
  web_accessible_resources?: Array<{ resources?: string[] }>;
}

function assertExists(root: string, relativePath: string): void {
  if (!existsSync(join(root, relativePath))) {
    throw new Error(`Missing extension artifact: ${root}/${relativePath}`);
  }
}

function assertGlobHasMatch(root: string, pattern: string): void {
  const slash = pattern.lastIndexOf('/');
  const directory = slash >= 0 ? pattern.slice(0, slash) : '';
  const filePattern = slash >= 0 ? pattern.slice(slash + 1) : pattern;
  const escapedParts = filePattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`^${escapedParts.join('.*')}$`);
  const entries = readdirSync(join(root, directory), { withFileTypes: true });
  if (!entries.some((entry) => entry.isFile() && regex.test(entry.name))) {
    throw new Error(`No artifact matches ${root}/${pattern}`);
  }
}

function checkRoot(root: string): void {
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

  for (const script of manifest.content_scripts?.flatMap((entry) => entry.js ?? []) ?? []) {
    assertExists(root, script);
  }
  const serviceWorker = manifest.background?.service_worker;
  if (serviceWorker) assertExists(root, serviceWorker);
  for (const backgroundScript of manifest.background?.scripts ?? []) {
    assertExists(root, backgroundScript);
  }
  for (const resource of manifest.web_accessible_resources?.flatMap(
    (entry) => entry.resources ?? []
  ) ?? []) {
    if (resource.includes('*')) assertGlobHasMatch(root, resource);
    else assertExists(root, resource);
  }
}

checkRoot('dist-extension');
checkRoot('dist-extension-firefox');
console.log('Extension artifact references are valid.');
