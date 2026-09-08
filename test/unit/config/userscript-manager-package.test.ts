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
class Response(io.BytesIO):
    def __init__(self, body=b'', status=200, location=None):
        super().__init__(body)
        self.status = status
        self.location = location
        self.read_sizes = []
    def getheader(self, name):
        assert name == 'Location'
        return self.location
    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)
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
    response = Response(b'unreviewed')
    with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response):
        try:
            manager.prepare(output)
            raise AssertionError('pin mismatch accepted')
        except ValueError as error:
            assert 'reviewed pin' in str(error)
    assert not output.exists()
    assert response.closed
`);
  });

  it('preserves an existing destination without accessing the network', () => {
    runPython(String.raw`
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory)
    sentinel = output / 'keep'
    sentinel.write_text('existing')
    with patch.object(manager.urllib.request.HTTPSHandler, 'https_open') as request:
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
    response = Response(body)
    with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response) as request:
        result = manager.prepare(output)
        request.assert_called_once()
        assert request.call_args.args[0].full_url == manager.URL
        assert request.call_args.args[0].timeout == 60
    from urllib.parse import parse_qs, urlsplit
    source = urlsplit(manager.URL)
    assert source.scheme == 'https' and source.netloc == 'clients2.google.com'
    assert source.path == '/service/update2/crx'
    assert parse_qs(source.query)['x'] == ['id=' + manager.EXTENSION_ID + '&uc']
    assert response.closed and response.read_sizes == [manager.MAX_ARCHIVE_BYTES + 1]
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
    with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=Response(body)):
        try:
            manager.prepare(output)
            raise AssertionError('traversal accepted')
        except ValueError as error:
            assert 'Unsafe' in str(error)
    assert list(Path(directory).iterdir()) == [sentinel]
`);
  });

  it('follows approved HTTPS and relative redirects without reading redirect bodies', () => {
    runPython(String.raw`
responses = [
    Response(b'ignored redirect body', 302, 'https://clients2.googleusercontent.com/package'),
    Response(b'ignored redirect body', 307, '/reviewed.crx?version=5.5.0'),
    Response(b'reviewed'),
]
with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', side_effect=responses) as request:
    assert manager.download_package() == b'reviewed'
assert [call.args[0].full_url for call in request.call_args_list] == [
    manager.URL, 'https://clients2.googleusercontent.com/package',
    'https://clients2.googleusercontent.com/reviewed.crx?version=5.5.0',
]
assert all(call.args[0].get_method() == 'GET' and call.args[0].timeout == 60
           for call in request.call_args_list)
assert [response.read_sizes for response in responses] == [[], [], [manager.MAX_ARCHIVE_BYTES + 1]]
for response in responses:
    assert response.closed
`);
  });

  it('rejects unsafe initial and redirect URLs before opening their destination', () => {
    runPython(String.raw`
unsafe_urls = [
    'file:///not-opened', 'ftp://clients2.googleusercontent.com/package',
    'http://clients2.googleusercontent.com/package', 'https://example.invalid/package',
    '//example.invalid/package', 'https://clients2.google.com.example.invalid/package',
    'https://clients2.google.com@127.0.0.1/package',
    'https://user@clients2.google.com/package', 'https://clients2.google.com:8443/package',
    'https://clients2.google.com:invalid/package',
    'https://clients2.google.com\\@example.invalid/package',
    ' https://clients2.google.com/package', 'https://clients2.google.com/\r\npackage',
]
for url in unsafe_urls:
    with patch.object(manager, 'URL', url), patch.object(manager.urllib.request.HTTPSHandler, 'https_open') as request:
        try:
            manager.download_package()
            raise AssertionError('unsafe initial URL accepted')
        except ValueError:
            pass
        request.assert_not_called()
for url in unsafe_urls + [None, '']:
    response = Response(b'not consumed', 302, url)
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'manager'
        with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response) as request:
            try:
                manager.prepare(output)
                raise AssertionError('unsafe redirect accepted')
            except ValueError:
                pass
            request.assert_called_once()
        assert request.call_args.args[0].full_url == manager.URL
        assert request.call_args.args[0].timeout == 60
        assert not output.exists()
    assert response.closed and response.read_sizes == []
`);
  });

  it('bounds redirects and closes every response without consuming their bodies', () => {
    runPython(String.raw`
responses = [Response(b'not consumed', 302, '/loop') for _ in range(manager.MAX_REDIRECTS + 1)]
with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', side_effect=responses) as request:
    try:
        manager.download_package()
        raise AssertionError('redirect loop accepted')
    except ValueError as error:
        assert 'Too many' in str(error)
    assert request.call_count == manager.MAX_REDIRECTS + 1
for response in responses:
    assert response.closed and response.read_sizes == []
`);
  });

  it('rejects failed HTTP responses and oversized packages before creating output', () => {
    runPython(String.raw`
responses = [Response(b'error', 404), Response(b'x' * (manager.MAX_ARCHIVE_BYTES + 2))]
for response in responses:
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'manager'
        with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response):
            try:
                manager.prepare(output)
                raise AssertionError('invalid download accepted')
            except ValueError:
                pass
        assert not output.exists()
    expected_reads = [] if response.status == 404 else [manager.MAX_ARCHIVE_BYTES + 1]
    assert response.closed and response.read_sizes == expected_reads
`);
  });

  it('preserves output state after a transport failure', () => {
    runPython(String.raw`
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory) / 'manager'
    with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', side_effect=OSError('connection lost')):
        try:
            manager.prepare(output)
            raise AssertionError('transport failure accepted')
        except OSError:
            pass
    assert not output.exists()
`);
  });
});
