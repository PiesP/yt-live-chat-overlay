import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version?: string;
};
const expectedVersion = process.env.BUILD_VERSION ?? packageJson.version;
if (!expectedVersion) {
  throw new Error('No version is available from BUILD_VERSION or package.json.');
}

const manifestFiles = ['extension/manifest.json', 'extension/manifest.firefox.json'] as const;

function checkVersions(): void {
  let failed = false;
  for (const file of manifestFiles) {
    const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as { version?: string };
    if (manifest.version !== expectedVersion) {
      console.error(
        `✗ ${file}: expected ${expectedVersion}, found ${manifest.version ?? '(missing)'}`
      );
      failed = true;
    } else {
      console.log(`✓ ${file}: ${manifest.version}`);
    }
  }
  if (failed) {
    throw new Error('Version mismatch detected. Run: pnpm sync:versions');
  }
  console.log(`\n✓ All versions match: ${expectedVersion}`);
}

function syncVersions(): void {
  const packageVersion = packageJson.version;
  if (!packageVersion) {
    throw new Error('package.json does not define a version.');
  }

  let synced = 0;
  for (const file of manifestFiles) {
    const path = resolve(root, file);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (manifest.version !== packageVersion) {
      manifest.version = packageVersion;
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`✓ Synced ${file} → v${packageVersion}`);
      synced++;
    } else {
      console.log(`✓ ${file} already at v${packageVersion}`);
    }
  }
  console.log(`\nDone. ${synced} file(s) synced.`);
}

const command = process.argv[2] ?? 'check';
if (command === 'check') checkVersions();
else if (command === 'sync') syncVersions();
else throw new Error(`Unknown version command: ${command}. Use "check" or "sync".`);
