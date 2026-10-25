// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const receiptPath = join(root, 'test-results', 'distribution-footprint.json');
const targets = ['dist', 'dist-extension', 'dist-extension-firefox'] as const;

export interface MeasuredFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface FootprintReceipt {
  schemaVersion: 1;
  sourceSha: string;
  coreSha: string;
  lockfileSha256: string;
  packageManager: string;
  pnpmVersion: string;
  nodeVersion: string;
  viteVersion: string;
  vitePlusVersion: string;
  buildVersion: string;
  mode: 'production';
  command: 'pnpm build:targets:ci';
  workerLimitBytes: number;
  sourceBound: boolean;
  files: MeasuredFile[];
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function measuredFiles(): MeasuredFile[] {
  const files: MeasuredFile[] = [];
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) {
        const data = readFileSync(path);
        files.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: data.length,
          sha256: sha256(data),
        });
      } else {
        throw new Error(`Non-file distribution entry: ${relative(root, path)}`);
      }
    }
  }
  for (const target of targets) visit(join(root, target));
  return files;
}

function lockfileSha256(): string {
  return sha256(readFileSync(join(root, 'pnpm-lock.yaml')));
}

export function recordFootprint(workerLimitBytes: number): string {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
    packageManager: string;
  };
  const pnpmVersion = execFileSync('pnpm', ['--version'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const receipt: FootprintReceipt = {
    schemaVersion: 1,
    sourceSha: git(['rev-parse', 'HEAD']),
    coreSha: git(['rev-parse', 'HEAD:packages/core']),
    lockfileSha256: lockfileSha256(),
    packageManager: manifest.packageManager,
    pnpmVersion,
    nodeVersion: process.versions.node,
    viteVersion: (
      JSON.parse(readFileSync(join(root, 'node_modules', 'vite', 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version,
    vitePlusVersion: (
      JSON.parse(readFileSync(join(root, 'node_modules', 'vite-plus', 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version,
    buildVersion: process.env.BUILD_VERSION ?? manifest.version,
    mode: 'production',
    command: 'pnpm build:targets:ci',
    workerLimitBytes,
    sourceBound: git(['status', '--porcelain', '--untracked-files=all']).length === 0,
    files: measuredFiles(),
  };
  if (receipt.files.length === 0) throw new Error('Distribution footprint has no files');
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temporary, receiptPath);
  return receiptPath;
}

export function verifiedFootprint(
  sourceSha: string,
  version: string,
  required: boolean
): FootprintReceipt | { status: 'unavailable' } {
  if (!existsSync(receiptPath)) {
    if (required) throw new Error('Missing producing-build distribution footprint receipt');
    return { status: 'unavailable' };
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as FootprintReceipt;
  const mismatch = [
    [receipt.schemaVersion === 1, 'schema'],
    [receipt.sourceSha === sourceSha, 'source'],
    [receipt.coreSha === git(['rev-parse', 'HEAD:packages/core']), 'core'],
    [receipt.lockfileSha256 === lockfileSha256(), 'lockfile'],
    [receipt.buildVersion === version, 'build version'],
    [receipt.mode === 'production', 'mode'],
    [receipt.command === 'pnpm build:targets:ci', 'command'],
    [
      Number.isSafeInteger(receipt.workerLimitBytes) && receipt.workerLimitBytes > 0,
      'worker limit',
    ],
    [JSON.stringify(receipt.files) === JSON.stringify(measuredFiles()), 'files'],
  ].find(([matches]) => !matches)?.[1];
  if (mismatch) {
    throw new Error(
      `Distribution footprint receipt does not match current source, inputs or files (${mismatch})`
    );
  }
  if (
    required &&
    (!receipt.sourceBound || git(['status', '--porcelain', '--untracked-files=all']).length !== 0)
  ) {
    throw new Error('Release distribution footprint requires a clean source-bound build');
  }
  return receipt;
}
