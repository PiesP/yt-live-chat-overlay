// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import test from 'node:test';

import { mediaResponse } from './reload-feedback.ts';

const bytes = Buffer.from('0123456789');

test('native media fixture serves complete and single byte ranges', () => {
  const complete = mediaResponse(bytes, null);
  assert.equal(complete.status, 200);
  assert.equal(complete.headers['accept-ranges'], 'bytes');
  assert.equal(complete.headers['content-length'], '10');
  assert.equal(complete.body.toString(), '0123456789');

  const open = mediaResponse(bytes, 'bytes=0-');
  assert.equal(open.status, 206);
  assert.equal(open.headers['content-range'], 'bytes 0-9/10');
  assert.equal(open.headers['content-length'], '10');
  assert.equal(open.body.toString(), '0123456789');

  const partial = mediaResponse(bytes, 'bytes=3-5');
  assert.equal(partial.status, 206);
  assert.equal(partial.headers['content-range'], 'bytes 3-5/10');
  assert.equal(partial.headers['content-length'], '3');
  assert.equal(partial.body.toString(), '345');

  const suffix = mediaResponse(bytes, 'bytes=-2');
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], 'bytes 8-9/10');
  assert.equal(suffix.body.toString(), '89');
});

test('native media fixture rejects unsatisfiable ranges', () => {
  for (const range of ['bytes=10-', 'bytes=5-4', 'bytes=-0', 'bytes=0-1,4-5', 'invalid']) {
    const response = mediaResponse(bytes, range);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers['content-range'], 'bytes */10', range);
    assert.equal(response.headers['content-length'], '0', range);
    assert.equal(response.body.length, 0, range);
  }
});
