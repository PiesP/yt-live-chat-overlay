// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const modulePath = resolve('validation/windows/prepare-userscript-manager.py');
const setup = String.raw`
import hashlib, importlib.util, io, json, struct, sys, tempfile, zipfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('manager', sys.argv[1])
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
def package(extra=None):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('manifest.json', json.dumps({'version': manager.VERSION, 'manifest_version': 3}))
        archive.writestr('background.js', 'trusted fixture')
        archive.writestr('_metadata/verified_contents.json', '{}')
        if extra:
            archive.writestr(extra, 'escape')
    return b'Cr24' + struct.pack('<II', 3, 0) + data.getvalue()
`;

function runPython(body: string): void {
  const result = spawnSync('python3', ['-c', setup + body, modulePath], { encoding: 'utf8' });
  expect(result.stderr, result.stdout).toBe('');
  expect(result.status).toBe(0);
}

describe('pinned userscript manager preparation', () => {
  it('rejects a changed Store package before creating output', () => {
    runPython(String.raw`
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory) / 'manager'
    with patch.object(manager.urllib.request, 'urlopen', return_value=io.BytesIO(b'unreviewed')):
        try:
            manager.prepare(output)
            raise AssertionError('pin mismatch accepted')
        except ValueError as error:
            assert 'reviewed pin' in str(error)
    assert not output.exists()
`);
  });

  it('preserves an existing destination without accessing the network', () => {
    runPython(String.raw`
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory)
    sentinel = output / 'keep'
    sentinel.write_text('existing')
    with patch.object(manager.urllib.request, 'urlopen') as request:
        try:
            manager.prepare(output)
            raise AssertionError('existing output accepted')
        except ValueError:
            pass
        request.assert_not_called()
    assert sentinel.read_text() == 'existing'
`);
  });

  it('extracts only reviewed application files and records package provenance', () => {
    runPython(String.raw`
body = package()
manager.SHA256 = hashlib.sha256(body).hexdigest()
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory) / 'manager'
    with patch.object(manager.urllib.request, 'urlopen', return_value=io.BytesIO(body)) as request:
        result = manager.prepare(output)
        request.assert_called_once_with(manager.URL, timeout=60)
    from urllib.parse import parse_qs, urlsplit
    source = urlsplit(manager.URL)
    assert source.scheme == 'https' and source.netloc == 'clients2.google.com'
    assert source.path == '/service/update2/crx'
    assert parse_qs(source.query)['x'] == ['id=' + manager.EXTENSION_ID + '&uc']
    assert result['version'] == manager.VERSION
    assert (output / 'background.js').read_text() == 'trusted fixture'
    assert not (output / '_metadata').exists()
    provenance = json.loads((output / 'installation-source.json').read_text())
    assert provenance['crx_sha256'] == manager.SHA256
    assert provenance['installation_method'] == 'unpacked-from-pinned-store-crx'
`);
  });

  it('rejects archive traversal and removes only its incomplete staging directory', () => {
    runPython(String.raw`
body = package('../escaped')
manager.SHA256 = hashlib.sha256(body).hexdigest()
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory) / 'manager'
    sentinel = Path(directory) / 'keep'
    sentinel.write_text('existing')
    with patch.object(manager.urllib.request, 'urlopen', return_value=io.BytesIO(body)):
        try:
            manager.prepare(output)
            raise AssertionError('traversal accepted')
        except ValueError as error:
            assert 'Unsafe' in str(error)
    assert list(Path(directory).iterdir()) == [sentinel]
`);
  });
});
