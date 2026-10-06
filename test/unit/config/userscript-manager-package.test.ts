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
def package(extra=None, manifest=None, extra_count=0):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('manifest.json', json.dumps(manifest if manifest is not None else {'version': manager.VERSION, 'manifest_version': 3}))
        archive.writestr('background.js', 'trusted fixture')
        archive.writestr('_metadata/verified_contents.json', '{}')
        if extra:
            archive.writestr(extra, 'escape')
        for index in range(extra_count):
            archive.writestr(f'files/{index:04d}', 'x')
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

  it('rejects a pinned package with the wrong manager or manifest version', () => {
    runPython(String.raw`
for manifest in [
    {'version': '0.0.0', 'manifest_version': 3},
    {'version': manager.VERSION, 'manifest_version': 2},
]:
    body = package(manifest=manifest)
    manager.SHA256 = hashlib.sha256(body).hexdigest()
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'manager'
        sentinel = Path(directory) / 'keep'
        sentinel.write_text('existing')
        response = Response(body)
        with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response):
            try:
                manager.prepare(output)
                raise AssertionError('wrong-version package accepted')
            except ValueError as error:
                assert 'Unexpected manager manifest' in str(error)
        assert response.closed
        assert sorted(path.name for path in Path(directory).iterdir()) == ['keep']
        assert sentinel.read_text() == 'existing'
`);
  });

  it('rejects invalid CRX headers and corrupt or truncated ZIP payloads', () => {
    runPython(String.raw`
good = package()
cases = [
    (b'Bad!' + good[4:], ValueError, 'Expected a Chrome CRX'),
    (good[:10], ValueError, 'Expected a Chrome CRX'),
    (good[:4] + struct.pack('<I', 2) + good[8:], ValueError, 'Invalid CRX3 header'),
    (good[:8] + struct.pack('<I', len(good)) + good[12:], ValueError, 'Invalid CRX3 header'),
    (good[:12] + b'not-a-zip', zipfile.BadZipFile, None),
    (good[:-22], zipfile.BadZipFile, None),
]
for body, expected_error, expected_message in cases:
    manager.SHA256 = hashlib.sha256(body).hexdigest()
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'manager'
        sentinel = Path(directory) / 'keep'
        sentinel.write_text('existing')
        response = Response(body)
        with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response):
            try:
                manager.prepare(output)
                raise AssertionError('damaged package accepted')
            except expected_error as error:
                if expected_message:
                    assert expected_message in str(error)
        assert response.closed
        assert sorted(path.name for path in Path(directory).iterdir()) == ['keep']
        assert sentinel.read_text() == 'existing'
`);
  });

  it('rejects symlink entries and excessive declared entry counts or expanded sizes', () => {
    runPython(String.raw`
link = zipfile.ZipInfo('link')
link.create_system = 3
link.external_attr = 0o120777 << 16
ordinary = package()
central_entry = ordinary.index(b'PK\x01\x02', 12)
oversized = (ordinary[:central_entry + 24] + struct.pack('<I', 64 * 1024 * 1024 + 1)
             + ordinary[central_entry + 28:])
for body, expected_message in [
    (package(extra=link), 'Unsafe package entry'),
    (package(extra_count=998), 'Unexpected package size'),
    (oversized, 'Unexpected package size'),
]:
    manager.SHA256 = hashlib.sha256(body).hexdigest()
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'manager'
        sentinel = Path(directory) / 'keep'
        sentinel.write_text('existing')
        response = Response(body)
        with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response):
            try:
                manager.prepare(output)
                raise AssertionError('unsafe archive accepted')
            except ValueError as error:
                assert expected_message in str(error)
        assert response.closed
        assert sorted(path.name for path in Path(directory).iterdir()) == ['keep']
`);
  });

  it('cleans staged files after extraction, provenance write, or final rename failures', () => {
    runPython(String.raw`
body = package()
manager.SHA256 = hashlib.sha256(body).hexdigest()
original_extract = zipfile.ZipFile.extract
def fail_after_manifest(self, member, path=None, pwd=None):
    if member.filename == 'background.js':
        raise OSError('archive write failed')
    return original_extract(self, member, path, pwd)
failures = [
    ('archive write failed', patch.object(zipfile.ZipFile, 'extract', fail_after_manifest)),
    ('provenance write failed', patch.object(Path, 'write_text', side_effect=OSError('provenance write failed'))),
    ('final rename failed', patch.object(Path, 'rename', side_effect=OSError('final rename failed'))),
]
for message, failure in failures:
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'manager'
        sentinel = Path(directory) / 'keep'
        sentinel.write_text('existing')
        response = Response(body)
        with patch.object(manager.urllib.request.HTTPSHandler, 'https_open', return_value=response), failure:
            try:
                manager.prepare(output)
                raise AssertionError('failed staged write accepted')
            except OSError as error:
                assert message in str(error)
        assert response.closed
        assert sorted(path.name for path in Path(directory).iterdir()) == ['keep']
        assert sentinel.read_text() == 'existing'
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
