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


def prepare(output):
    output = output.absolute()
    if output.exists():
        raise ValueError('Choose a new output directory.')
    # Fixed HTTPS endpoint with no caller-controlled URL. This audit rule also
    # flags a literal URL when the required timeout keyword is present.
    with urllib.request.urlopen(URL, timeout=60) as response:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        body = response.read(MAX_ARCHIVE_BYTES + 1)
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
