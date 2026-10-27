import { appendFileSync, lstatSync, readFileSync } from 'node:fs';

// The current checked-out source owns its runtime; tagged history uses a
// verified numeric override directly with the immutable shared setup action.
if (!lstatSync('.node-version').isFile()) {
  throw new Error('Expected a regular .node-version file');
}
const contents = readFileSync('.node-version', 'utf8');
const version = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Expected an exact .node-version pin');
}
if (process.env.REQUESTED_NODE_VERSION && process.env.REQUESTED_NODE_VERSION !== version) {
  throw new Error('Release workflow runtime differs from the checked-out .node-version pin');
}
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
