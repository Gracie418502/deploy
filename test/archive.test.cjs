'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('restore archive validation rejects traversal, links and device files', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util, io, tarfile, tempfile
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for name, kind, valid in [('./database.sql.gz', tarfile.REGTYPE, True), ('../escape', tarfile.REGTYPE, False), ('/absolute', tarfile.REGTYPE, False), ('link', tarfile.SYMTYPE, False), ('hardlink', tarfile.LNKTYPE, False), ('device', tarfile.CHRTYPE, False)]:
    with tempfile.NamedTemporaryFile(suffix='.tar.gz') as archive:
        with tarfile.open(fileobj=archive, mode='w:gz') as bundle:
            member = tarfile.TarInfo(name)
            member.type = kind
            bundle.addfile(member, io.BytesIO(b''))
        archive.flush()
        try:
            module.validate(archive.name)
        except ValueError:
            assert not valid, name
        else:
            assert valid, name
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('manifest validation accepts a valid versioned manifest', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util, json
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = {
    'schemaVersion': 1,
    'postgresServerVersion': '16.3',
    'pgDumpVersion': '16.3',
    'componentChecksums': {
        'database.sql.gz': 'a' * 64,
        'contracts.tar.gz': 'b' * 64,
    },
}
module.validate_manifest(manifest)
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('manifest validation rejects an unsupported schema version', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = {
    'schemaVersion': 999,
    'postgresServerVersion': '16.3',
    'pgDumpVersion': '16.3',
    'componentChecksums': {
        'database.sql.gz': 'a' * 64,
        'contracts.tar.gz': 'b' * 64,
    },
}
try:
    module.validate_manifest(manifest)
except ValueError:
    pass
else:
    raise AssertionError('unsupported schemaVersion was accepted')
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('manifest validation rejects missing required fields and wrong types', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
base = {
    'schemaVersion': 1,
    'postgresServerVersion': '16.3',
    'pgDumpVersion': '16.3',
    'componentChecksums': {
        'database.sql.gz': 'a' * 64,
        'contracts.tar.gz': 'b' * 64,
    },
}
invalid = []
for field in ('schemaVersion', 'postgresServerVersion', 'pgDumpVersion', 'componentChecksums'):
    manifest = dict(base)
    del manifest[field]
    invalid.append(manifest)
for field, value in (
    ('schemaVersion', '1'),
    ('schemaVersion', True),
    ('postgresServerVersion', 16),
    ('pgDumpVersion', None),
    ('componentChecksums', []),
    ('componentChecksums', 'not-a-mapping'),
):
    manifest = dict(base)
    manifest[field] = value
    invalid.append(manifest)
for manifest in invalid:
    try:
        module.validate_manifest(manifest)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid manifest was accepted: %r' % (manifest,))
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('archive validation enforces the component allowlist', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util, io, tarfile, tempfile
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def build(members):
    archive = tempfile.NamedTemporaryFile(suffix='.tar.gz')
    with tarfile.open(fileobj=archive, mode='w:gz') as bundle:
        for name, kind, mode, payload in members:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.mode = mode
            data = payload or b''
            member.size = len(data)
            bundle.addfile(member, io.BytesIO(data))
    archive.flush()
    return archive

def accepts(members):
    archive = build(members)
    try:
        module.validate(archive.name)
    finally:
        archive.close()

def rejects(members):
    archive = build(members)
    try:
        try:
            module.validate(archive.name)
        except ValueError:
            pass
        else:
            raise AssertionError('archive was accepted: %r' % ([m[0] for m in members],))
    finally:
        archive.close()

allowed = [
    ('database.sql.gz', tarfile.REGTYPE, 0o644, b'data'),
    ('contracts.tar.gz', tarfile.REGTYPE, 0o644, b'data'),
    ('manifest.json', tarfile.REGTYPE, 0o644, b'{}'),
]
accepts(allowed)
accepts(allowed[:2])

rejects(allowed + [('extra.sh', tarfile.REGTYPE, 0o644, b'#!/bin/sh\\n')])
rejects(allowed + [('payload', tarfile.REGTYPE, 0o755, b'')])
rejects(allowed + [('unrelated.txt', tarfile.REGTYPE, 0o644, b'')])
rejects(allowed + [('nested/database.sql.gz', tarfile.REGTYPE, 0o644, b'data')])
rejects([allowed[0], allowed[2]])
rejects([allowed[1], allowed[2]])
rejects([allowed[2]])
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('manifest validation rejects malformed component checksums', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
base = {
    'schemaVersion': 1,
    'postgresServerVersion': '16.3',
    'pgDumpVersion': '16.3',
    'componentChecksums': {
        'database.sql.gz': 'a' * 64,
        'contracts.tar.gz': 'b' * 64,
    },
}
invalid_checksums = [
    {},
    {'database.sql.gz': 'a' * 64},
    {'database.sql.gz': 'a' * 64, 'contracts.tar.gz': 'b' * 64, '../escape': 'c' * 64},
    {'database.sql.gz': 'not-a-hash', 'contracts.tar.gz': 'b' * 64},
    {'database.sql.gz': 'a' * 63, 'contracts.tar.gz': 'b' * 64},
    {'database.sql.gz': 'g' * 64, 'contracts.tar.gz': 'b' * 64},
    {'database.sql.gz': 123, 'contracts.tar.gz': 'b' * 64},
]
for checksums in invalid_checksums:
    manifest = dict(base)
    manifest['componentChecksums'] = checksums
    try:
        module.validate_manifest(manifest)
    except ValueError:
        pass
    else:
        raise AssertionError('malformed checksums were accepted: %r' % (checksums,))
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});