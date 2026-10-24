// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readFocusedScenario } from './profile.ts';

test('focused Windows selectors dispatch by their own file and reject ambiguity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yt-visual-selector-'));
  const inputs = join(root, 'validation/windows/inputs');
  const settings = join(inputs, 'settings-persistence.json');
  const reload = join(inputs, 'reload-feedback.json');
  const translation = join(inputs, 'translation-runtime.json');
  const viewing = join(inputs, 'viewing-experience.json');
  try {
    await mkdir(inputs, { recursive: true });
    assert.equal(await readFocusedScenario(root), null);

    await writeFile(reload, '{"scenario":"reload-feedback"}');
    assert.equal(await readFocusedScenario(root), 'reload-feedback');
    await rm(reload);

    await writeFile(translation, '{"scenario":"translation-runtime"}');
    assert.equal(await readFocusedScenario(root), 'translation-runtime');
    await rm(translation);

    await writeFile(viewing, '{"scenario":"viewing-experience"}');
    assert.equal(await readFocusedScenario(root), 'viewing-experience');
    await rm(viewing);

    await writeFile(settings, '{"scenario":"settings-persistence"}');
    assert.equal(await readFocusedScenario(root), 'settings-persistence');
    await writeFile(reload, '{"scenario":"reload-feedback"}');
    await assert.rejects(readFocusedScenario(root), /mutually exclusive/u);

    await writeFile(viewing, '{"scenario":"viewing-experience"}');
    await assert.rejects(readFocusedScenario(root), /mutually exclusive/u);

    await rm(viewing);

    await rm(reload);
    await writeFile(translation, '{"scenario":"translation-runtime"}');
    await assert.rejects(readFocusedScenario(root), /mutually exclusive/u);

    await rm(settings);
    await writeFile(translation, '{"scenario":"settings-persistence"}');
    await assert.rejects(readFocusedScenario(root), /does not match its file/u);

    await rm(translation);
    await writeFile(viewing, '{"scenario":"translation-runtime"}');
    await assert.rejects(readFocusedScenario(root), /does not match its file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
