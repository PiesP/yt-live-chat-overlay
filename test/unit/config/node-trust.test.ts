import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const directory = resolve(import.meta.dirname, '../../../.github/workflows');
const workflows = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => [name, readFileSync(resolve(directory, name), 'utf8')])
);
const trustAction =
  'PiesP/browser-core/automation/actions/prepare-node-trust@381b4ca733494cf069212cd0d16458389a83c623';
const settings = {
  NODE_OPTIONS: '--use-openssl-ca',
  SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
  SSL_CERT_DIR: '/etc/ssl/certs',
};

describe('JavaScript Action trust boundary', () => {
  it('protects the first Action and post steps in every workflow job', () => {
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
    for (const [path, workflow] of Object.entries(workflows)) {
      const jobs = workflow.split('\njobs:\n')[1];
      expect(jobs, path).toBeDefined();
      for (const [name, value] of Object.entries(settings)) {
        // Workflow scope reaches bootstrap, child processes and Action post steps.
        expect(workflow, path).toContain(`\n  ${name}: ${value}\n`);
        expect(workflow, path).not.toMatch(new RegExp(`^ {4,}${name}:`, 'm'));
      }
      expect(workflow, path).not.toMatch(/NODE_EXTRA_CA_CERTS:|NODE_TLS_REJECT_UNAUTHORIZED:/u);
      for (const block of (jobs ?? '').split(/(?=^  [\w-]+:\n)/mu).filter(Boolean)) {
        const job = `${path}:${block.split('\n')[0]}`;
        expect(block, job).not.toMatch(/^    uses:/mu);
        if (!/^      - uses:|^        uses:/mu.test(block)) {
          expect(block, job).not.toContain(trustAction);
          continue;
        }
        const steps = block.split('    steps:\n')[1] ?? '';
        const firstStep = steps.split('\n      - ')[0] ?? '';
        expect(firstStep, job).toContain(`uses: ${trustAction}`);
        expect(firstStep, job).not.toMatch(/^        (?:if|continue-on-error):/mu);
        expect(block, job).toContain('runs-on: ubuntu-24.04');
      }
    }
  });
});

it('keeps failure-path Actions behind successful trust preparation', () => {
  const directory = resolve(import.meta.dirname, '../../../.github/workflows');
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name))) {
    const workflow = readFileSync(resolve(directory, file), 'utf8');
    for (const job of (workflow.split('\njobs:\n')[1] ?? '').split(/(?=^  [\w-]+:\n)/mu)) {
      const steps = job.split('    steps:\n')[1] ?? '';
      const first = steps.split('\n      - ')[0] ?? '';
      for (const step of steps.split(/(?=^      - )/mu)) {
        if (!/^      - uses:|^        uses:/mu.test(step)) continue;
        const condition = step.match(/^        if: (.*)$/mu)?.[1] ?? '';
        if (!/\b(?:always|failure|cancelled)\(/u.test(condition)) continue;
        expect(first, `${file}: primer identity`).toContain('id: node_trust');
        expect(condition, `${file}: ${step.split('\n')[0]}`).toMatch(
          /^\$\{\{ steps\.node_trust\.outcome == 'success' && \(/u
        );
      }
    }
  }
});
