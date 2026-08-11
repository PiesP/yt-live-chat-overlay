// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface ExtensionManifest {
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
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

function checkFirefoxContract(): void {
  const relativeDirectory = 'dist-extension-firefox';
  const directory = join(root, relativeDirectory);
  const manifest = JSON.parse(
    readFileSync(join(directory, 'manifest.json'), 'utf8')
  ) as ExtensionManifest;
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko?.id || !gecko.strict_min_version) {
    throw new Error(`${relativeDirectory}/manifest.json is missing the Gecko identity contract.`);
  }
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

if (process.argv.includes('--e2e')) {
  assertExists(root, 'dist/yt-live-chat-overlay.dev.user.js');
  checkExtension('dist-extension');
} else {
  checkExtension('dist-extension');
  checkExtension('dist-extension-firefox');
  checkFirefoxContract();
}
console.log('Build artifact references are valid.');
