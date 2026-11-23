#!/usr/bin/env python3
"""Reject archive members that could escape the restore directory and
validate backup manifests before a restore is attempted."""
import json
import os
import re
import sys
import tarfile
from pathlib import PurePosixPath

# Manifest schema versions this validator understands. Restores must reject
# anything outside this set before touching the database.
SUPPORTED_SCHEMA_VERSIONS = (1,)

# Default budgets for archive expansion. These bound the work a restore can
# trigger before any member is extracted.
DEFAULT_MAX_MEMBERS = 10000
DEFAULT_MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 * 1024  # 10 GiB

ENV_MAX_MEMBERS = 'RESTORE_MAX_MEMBERS'
ENV_MAX_UNCOMPRESSED_BYTES = 'RESTORE_MAX_UNCOMPRESSED_BYTES'

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

# Archive members a restore plan reports on. These are informational: plan mode
# lists which are present without requiring any particular one.
KNOWN_ARCHIVE_COMPONENTS = ('database.sql.gz', 'tables.txt', 'contracts/')

# Optional, backward-compatible status fields. Older manifests omit them; when
# present they must be non-empty strings so plan mode can report them.
OPTIONAL_STATUS_FIELDS = ('upload_status', 'retention_status')


def _member_path(member):
    return PurePosixPath(member.name)


def _check_member(member):
    path = _member_path(member)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError(f'unsafe archive path: {member.name}')
    if not (member.isfile() or member.isdir()):
        raise ValueError(f'unsupported archive member: {member.name}')


def normalize_member_name(name):
    """Return a canonical member path for duplicate detection.

    Strips leading './', collapses redundant slashes and resolves '.' segments
    so that equivalent spellings map to the same normalized name.
    """
    parts = []
    for part in name.split('/'):
        if part in ('', '.'):
            continue
        parts.append(part)
    return '/'.join(parts)


def _resolve_budget(explicit, env_name, default, label):
    if explicit is not None:
        value = explicit
    elif os.environ.get(env_name):
        raw = os.environ[env_name]
        try:
            value = int(raw)
        except ValueError:
            raise ValueError(f'{env_name} must be an integer, got: {raw!r}')
    else:
        value = default
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f'{label} must be a non-negative integer')
    return value


def validate(archive, max_members=None, max_uncompressed_bytes=None):
    max_members = _resolve_budget(
        max_members, ENV_MAX_MEMBERS, DEFAULT_MAX_MEMBERS, 'max_members'
    )
    max_uncompressed_bytes = _resolve_budget(
        max_uncompressed_bytes,
        ENV_MAX_UNCOMPRESSED_BYTES,
        DEFAULT_MAX_UNCOMPRESSED_BYTES,
        'max_uncompressed_bytes',
    )

    seen = set()
    member_count = 0
    total_size = 0
    with tarfile.open(archive, 'r:gz') as bundle:
        for member in bundle:
            _check_member(member)


def inspect_archive(archive):
    """Validate archive safety and report its known components.

    Returns a dict mapping each known component name to a boolean indicating
    whether it is present. No database writes or extraction occur.
    """
    present = {name: False for name in KNOWN_ARCHIVE_COMPONENTS}
    with tarfile.open(archive, 'r:gz') as bundle:
        for member in bundle:
            _check_member(member)
            name = member.name
            if name in present:
                present[name] = True
            elif name.startswith('contracts/'):
                present['contracts/'] = True
    return present

            normalized = normalize_member_name(member.name)
            if normalized in seen:
                raise ValueError(f'duplicate archive member: {member.name}')
            seen.add(normalized)

            member_count += 1
            if member_count > max_members:
                raise ValueError(
                    f'archive exceeds member budget of {max_members}'
                )
            total_size += member.size
            if total_size > max_uncompressed_bytes:
                raise ValueError(
                    'archive exceeds uncompressed size budget of '
                    f'{max_uncompressed_bytes} bytes'
                )


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

    for field in OPTIONAL_STATUS_FIELDS:
        if field in manifest:
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


def _parse_args(argv):
    """Parse positional archive/manifest plus optional budget flags."""
    max_members = None
    max_uncompressed_bytes = None
    positional = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == '--max-members':
            index += 1
            if index >= len(argv):
                raise ValueError('--max-members requires a value')
            max_members = argv[index]
        elif arg.startswith('--max-members='):
            max_members = arg.split('=', 1)[1]
        elif arg == '--max-uncompressed-bytes':
            index += 1
            if index >= len(argv):
                raise ValueError('--max-uncompressed-bytes requires a value')
            max_uncompressed_bytes = argv[index]
        elif arg.startswith('--max-uncompressed-bytes='):
            max_uncompressed_bytes = arg.split('=', 1)[1]
        else:
            positional.append(arg)
        index += 1

    if not positional:
        raise ValueError(
            'usage: validate-archive.py [--max-members N] '
            '[--max-uncompressed-bytes N] <archive> [manifest]'
        )
    if len(positional) > 2:
        raise ValueError(
            'usage: validate-archive.py [--max-members N] '
            '[--max-uncompressed-bytes N] <archive> [manifest]'
        )

    def _to_int(value, label):
        if value is None:
            return None
        try:
            return int(value)
        except ValueError:
            raise ValueError(f'{label} must be an integer, got: {value!r}')

    return (
        positional[0],
        positional[1] if len(positional) > 1 else None,
        _to_int(max_members, '--max-members'),
        _to_int(max_uncompressed_bytes, '--max-uncompressed-bytes'),
    )


if __name__ == '__main__':
    try:
        archive, manifest, max_members, max_uncompressed_bytes = _parse_args(
            sys.argv[1:]
        )
        validate(archive, max_members, max_uncompressed_bytes)
        if manifest is not None:
            validate_manifest_file(manifest)
    except (OSError, ValueError, tarfile.TarError) as error:
        sys.exit(str(error))