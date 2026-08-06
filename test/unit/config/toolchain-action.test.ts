import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const action = readFileSync(
  resolve(root, '.github/actions/setup-toolchain/action.yaml'),
  'utf8'
);

describe('setup-toolchain action', () => {
  it('uses pnpm/setup v2 with the repository packageManager pin directly', () => {
    expect(action).toContain(
      'uses: pnpm/setup@c9883cc79df532ad1a7b81bf9ab944ceb090d65c # v2.0.0'
    );
    expect(action).toContain('package-json-file: package.json');
    expect(action).toContain('runtime: "node@${{ inputs.node-version }}"');
    expect(action).not.toContain('self-update');
    expect(action).not.toContain('bin-dest');
    expect(action).not.toContain('11.7.0');
    expect(
      existsSync(resolve(root, '.github/actions/setup-toolchain/bootstrap-package.json'))
    ).toBe(false);
  });
});
