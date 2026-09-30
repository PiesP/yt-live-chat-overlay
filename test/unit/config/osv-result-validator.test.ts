import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const validator = resolve(import.meta.dirname, '../../../scripts/security/validate-osv-results.py');
const directories: string[] = [];

function validate(raw: string, samePath = false, staleOutput = false) {
  const directory = mkdtempSync(join(tmpdir(), 'osv-validator-'));
  directories.push(directory);
  const input = join(directory, 'raw.json');
  const output = samePath ? input : join(directory, 'validated.json');
  writeFileSync(input, raw);
  if (staleOutput && !samePath) writeFileSync(output, 'stale');
  const result = spawnSync('python3', ['-I', validator, '--input', input, '--output', output], {
    encoding: 'utf8',
  });
  return { result, input, output };
}

const finding = {
  results: [{
    source: { type: 'lockfile', path: '/src/pnpm-lock.yaml' },
    packages: [{
      package: { ecosystem: 'npm', name: 'sample', version: '1.0.0' },
      vulnerabilities: [{ id: 'GHSA-jmr9-qjv8-65gv' }],
      groups: [{ ids: ['GHSA-jmr9-qjv8-65gv'], aliases: [] }],
    }],
  }],
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('OSV result validator', () => {
  it('preserves every vulnerability, including a formerly excepted ID', () => {
    const { result, output } = validate(JSON.stringify(finding));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(finding);
  });

  it('preserves unknown scanner metadata for the reporter', () => {
    const input = { ...finding, scanner_metadata: { future_field: true } };
    const { result, output } = validate(JSON.stringify(input));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(input);
  });

  it.each([
    ['duplicate key', '{"results":[],"results":[]}'],
    ['non-finite number', '{"results":[],"future_metric":NaN}'],
    ['overflowed number', '{"results":[],"future_metric":1e400}'],
    ['invalid severity', JSON.stringify({
      results: [{ ...finding.results[0], packages: [{
        ...finding.results[0]?.packages[0],
        vulnerabilities: [{ id: 'GHSA-test', severity: 42 }],
      }] }],
    })],
    ['malformed JSON', '{'],
  ])('rejects %s before creating output', (_label, raw) => {
    const { result, output } = validate(raw);
    expect(result.status).toBe(2);
    expect(existsSync(output)).toBe(false);
  });

  it('removes stale output after a failed validation', () => {
    const { result, output } = validate('{', false, true);
    expect(result.status).toBe(2);
    expect(existsSync(output)).toBe(false);
  });

  it('rejects output that aliases the input without modifying it', () => {
    const raw = JSON.stringify(finding);
    const { result, input } = validate(raw, true);
    expect(result.status).toBe(2);
    expect(readFileSync(input, 'utf8')).toBe(raw);
  });
});
