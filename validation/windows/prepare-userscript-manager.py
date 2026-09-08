#!/usr/bin/env python3
"""Prepare a pinned official Tampermonkey package for isolated installation tests."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import tempfile
import urllib.request
from urllib.parse import urljoin, urlsplit
import zipfile

VERSION = '5.5.0'
SHA256 = 'bcaec082c439e11c4df683f43d07e9ac3d4439251d72b91c5b452f977dac15d5'
EXTENSION_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'
URL = (
    'https://clients2.google.com/service/update2/crx?response=redirect'
    '&prodversion=152.0.7977.83&acceptformat=crx3&prod=chromecrx&prodchannel=stable'
    '&os=win&arch=x64&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc'
)
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_REDIRECTS = 5
STORE_HOSTS = frozenset(('clients2.google.com', 'clients2.googleusercontent.com'))


def store_url(value, base=URL):
    if not value or '\\' in value or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise ValueError('Invalid Store download URL.')
    target = urlsplit(urljoin(base, value))
    if (target.scheme != 'https' or target.hostname not in STORE_HOSTS
            or target.username is not None or target.password is not None
            or target.port not in (None, 443)):
        raise ValueError('Store downloads require an approved HTTPS origin.')
    return target


def download_package():
    target = store_url(URL)
    # Register HTTPS only: no file/FTP/HTTP, proxy, or automatic redirect handlers.
    opener = urllib.request.OpenerDirector()
    opener.add_handler(urllib.request.HTTPSHandler())
    for redirects in range(MAX_REDIRECTS + 1):
        with opener.open(target.geturl(), timeout=60) as response:
            if response.status in (301, 302, 303, 307, 308):
                if redirects == MAX_REDIRECTS:
                    raise ValueError('Too many Store download redirects.')
                target = store_url(response.getheader('Location'), target.geturl())
                continue
            if response.status != 200:
                raise ValueError(f'Store download failed with HTTP {response.status}.')
            return response.read(MAX_ARCHIVE_BYTES + 1)


def prepare(output):
    output = output.absolute()
    if output.exists():
        raise ValueError('Choose a new output directory.')
    body = download_package()
    if len(body) > MAX_ARCHIVE_BYTES or hashlib.sha256(body).hexdigest() != SHA256:
        raise ValueError('The Store package does not match the reviewed pin; review a new version first.')
    if body[:4] != b'Cr24' or len(body) < 12:
        raise ValueError('Expected a Chrome CRX package.')
    version, header_size = struct.unpack_from('<II', body, 4)
    if version != 3 or header_size > len(body) - 12:
        raise ValueError('Invalid CRX3 header.')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='userscript-manager-', dir=output.parent))
    try:
        with zipfile.ZipFile(io.BytesIO(body[12 + header_size:])) as archive:
            entries = archive.infolist()
            if len(entries) > 1000 or sum(entry.file_size for entry in entries) > 64 * 1024 * 1024:
                raise ValueError('Unexpected package size.')
            for entry in entries:
                path = Path(entry.filename)
                if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename
                        or ':' in entry.filename or (entry.external_attr >> 16) & 0o170000 == 0o120000):
                    raise ValueError('Unsafe package entry.')
                # Store signature metadata is not application code and is not
                # consumed by Chrome's unpacked developer installation path.
                if path.parts and path.parts[0] == '_metadata':
                    continue
                archive.extract(entry, temporary)
        manifest = json.loads((temporary / 'manifest.json').read_text())
        if manifest['version'] != VERSION or manifest['manifest_version'] != 3:
            raise ValueError('Unexpected manager manifest.')
        (temporary / 'installation-source.json').write_text(json.dumps({
            'name': 'Tampermonkey', 'version': VERSION, 'store_extension_id': EXTENSION_ID,
            'source_url': URL, 'crx_sha256': SHA256,
            'installation_method': 'unpacked-from-pinned-store-crx',
            'omitted_directory': '_metadata',
        }, indent=2))
        temporary.rename(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {'directory': str(output), 'version': VERSION, 'crx_sha256': SHA256}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    print(json.dumps(prepare(parser.parse_args().output), indent=2))
