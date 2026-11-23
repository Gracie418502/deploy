#!/usr/bin/env python3
"""Reject archive members that could escape the restore directory and
validate backup manifests before a restore is attempted."""
import json
import re
import sys
import tarfile
from pathlib import PurePosixPath

# Manifest schema versions this validator understands. Restores must reject
# anything outside this set before touching the database.
SUPPORTED_SCHEMA_VERSIONS = (1,)

SHA256_HEX = re.compile(r'^[0-9a-f]{64}$')

REQUIRED_STRING_FIELDS = (
    'name',
    'timestamp',
    'encryption',
    'storage',
    'source',
    'postgresServerVersion',
    'pgDumpVersion',
)

REQUIRED_COMPONENTS = ('database', 'contracts')

# Top-level entries a restore bundle may contain. Anything else is rejected so
# unexplained executables or unrelated files cannot ride along with a restore.
ALLOWED_TOP_LEVEL = frozenset({
    'database.sql.gz',
    'tables.txt',
    'contracts',
    'manifest.json',
})

# Optional metadata files that may appear at the top level but are not required.
OPTIONAL_METADATA = frozenset({
    'README',
    'README.md',
    'metadata.json',
})

# Top-level components that must be present for a bundle to be restorable.
REQUIRED_TOP_LEVEL = frozenset({
    'database.sql.gz',
    'contracts',
    'manifest.json',
})


def _top_level(name):
    """Return the first path component of an archive member name."""
    parts = PurePosixPath(name).parts
    return parts[0] if parts else ''


def validate_components(names):
    """Validate the set of archive member names against the component allowlist.

    Rejects unknown top-level entries and fails closed when a required
    top-level component is missing.
    """
    present = set()
    for name in names:
        top = _top_level(name)
        if not top:
            raise ValueError(f'unsupported archive member: {name}')
        if top not in ALLOWED_TOP_LEVEL and top not in OPTIONAL_METADATA:
            raise ValueError(f'unexpected top-level archive entry: {top}')
        present.add(top)

    missing = sorted(REQUIRED_TOP_LEVEL - present)
    if missing:
        raise ValueError(
            'archive missing required top-level component(s): ' + ', '.join(missing)
        )
    return present


def validate(archive):
    with tarfile.open(archive, 'r:gz') as bundle:
        names = []
        for member in bundle:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError(f'unsafe archive path: {member.name}')
            if not (member.isfile() or member.isdir()):
                raise ValueError(f'unsupported archive member: {member.name}')
            if member.mode & 0o111:
                raise ValueError(f'executable archive member: {member.name}')
            names.append(member.name)
        validate_components(names)


def _require(manifest, field):
    if field not in manifest:
        raise ValueError(f'manifest missing required field: {field}')
    return manifest[field]


def _require_string(manifest, field):
    value = _require(manifest, field)
    if not isinstance(value, str) or not value:
        raise ValueError(f'manifest field {field} must be a non-empty string')
    return value


def _validate_checksum(value, label):
    if not isinstance(value, str) or not SHA256_HEX.match(value):
        raise ValueError(
            f'manifest {label} must be a 64-character lowercase hex SHA-256 string'
        )


def validate_manifest(manifest):
    """Validate a parsed manifest dict against the supported schema."""
    if not isinstance(manifest, dict):
        raise ValueError('manifest must be a JSON object')

    version = _require(manifest, 'schemaVersion')
    if isinstance(version, bool) or not isinstance(version, int):
        raise ValueError('manifest schemaVersion must be an integer')
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        supported = ', '.join(str(v) for v in SUPPORTED_SCHEMA_VERSIONS)
        raise ValueError(
            f'unsupported manifest schemaVersion {version}; supported: {supported}'
        )

    for field in REQUIRED_STRING_FIELDS:
        _require_string(manifest, field)

    size = _require(manifest, 'sizeBytes')
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ValueError('manifest sizeBytes must be a non-negative integer')

    checksum = _require(manifest, 'checksum')
    if not isinstance(checksum, dict):
        raise ValueError('manifest checksum must be an object')
    algorithm = _require(checksum, 'algorithm')
    if not isinstance(algorithm, str) or not algorithm:
        raise ValueError('manifest checksum.algorithm must be a non-empty string')
    _validate_checksum(_require(checksum, 'value'), 'checksum.value')

    artifacts = _require(manifest, 'artifacts')
    if not isinstance(artifacts, list):
        raise ValueError('manifest artifacts must be a list')

    components = _require(manifest, 'componentChecksums')
    if not isinstance(components, dict):
        raise ValueError('manifest componentChecksums must be an object')
    for component in REQUIRED_COMPONENTS:
        if component not in components:
            raise ValueError(
                f'manifest componentChecksums missing required component: {component}'
            )
        _validate_checksum(components[component], f'componentChecksums.{component}')

    return manifest


def validate_manifest_file(path):
    """Load and validate a manifest JSON file, returning the parsed manifest."""
    with open(path, encoding='utf-8') as handle:
        try:
            manifest = json.load(handle)
        except json.JSONDecodeError as error:
            raise ValueError(f'invalid manifest JSON: {error}') from error
    return validate_manifest(manifest)


if __name__ == '__main__':
    try:
        if len(sys.argv) < 2:
            raise ValueError('usage: validate-archive.py <archive> [manifest]')
        validate(sys.argv[1])
        if len(sys.argv) > 2:
            validate_manifest_file(sys.argv[2])
    except (OSError, ValueError, tarfile.TarError) as error:
        sys.exit(str(error))