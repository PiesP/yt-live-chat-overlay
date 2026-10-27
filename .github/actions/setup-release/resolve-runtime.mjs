import { appendFileSync, closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

// The current checked-out source owns its runtime; tagged history uses a
// verified numeric override directly with the immutable shared setup action.
const descriptor = openSync(
  '.node-version',
  constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
);
let contents;
try {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.size > 64) {
    throw new Error('Expected a small regular .node-version file');
  }
  contents = readFileSync(descriptor, 'utf8');
} finally {
  closeSync(descriptor);
}
const version = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Expected an exact .node-version pin');
}
if (process.env.REQUESTED_NODE_VERSION && process.env.REQUESTED_NODE_VERSION !== version) {
  throw new Error('Release workflow runtime differs from the checked-out .node-version pin');
}
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
