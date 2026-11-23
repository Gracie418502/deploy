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

test('backup status reports upload success and prune failure independently', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
status = module.build_status(
    upload={'ok': True, 'destination': 's3://bucket/backups'},
    prune={'ok': False, 'error': 'retention cleanup failed'},
)
assert status['upload']['ok'] is True, status
assert status['prune']['ok'] is False, status
assert status['recoverable'] is True, status
assert status['ok'] is False, status
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('backup status reports upload failure as not recoverable', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
status = module.build_status(
    upload={'ok': False, 'error': 'upload failed'},
    prune={'ok': True},
)
assert status['upload']['ok'] is False, status
assert status['prune']['ok'] is True, status
assert status['recoverable'] is False, status
assert status['ok'] is False, status
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('backup status reports full success when upload and prune succeed', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
status = module.build_status(
    upload={'ok': True, 'destination': 's3://bucket/backups'},
    prune={'ok': True},
)
assert status['upload']['ok'] is True, status
assert status['prune']['ok'] is True, status
assert status['recoverable'] is True, status
assert status['ok'] is True, status
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('multi-recipient age encryption lets either identity decrypt without embedding identities', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util, os, shutil, subprocess, tempfile
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if shutil.which('age') is None or shutil.which('age-keygen') is None:
    raise SystemExit(0)
with tempfile.TemporaryDirectory() as tmp:
    identities = []
    recipients = []
    for index in range(2):
        key_path = os.path.join(tmp, 'identity-%d.txt' % index)
        subprocess.run(['age-keygen', '-o', key_path], check=True, capture_output=True)
        identities.append(key_path)
        with open(key_path, encoding='utf-8') as handle:
            for line in handle:
                if line.startswith('# public key:'):
                    recipients.append(line.split(':', 1)[1].strip())
    recipient_file = os.path.join(tmp, 'recipients.txt')
    with open(recipient_file, 'w', encoding='utf-8') as handle:
        handle.write('\\n'.join(recipients) + '\\n')
    plaintext = os.path.join(tmp, 'payload.bin')
    with open(plaintext, 'wb') as handle:
        handle.write(b'backup-payload')
    ciphertext = os.path.join(tmp, 'payload.age')
    module.age_encrypt(plaintext, ciphertext, recipient_file=recipient_file)
    with open(ciphertext, 'rb') as handle:
        blob = handle.read()
    for identity in identities:
        with open(identity, encoding='utf-8') as handle:
            key = [line.split(':', 1)[1].strip() for line in handle if line.startswith('# public key:')][0]
        assert key.encode() not in blob, 'recipient identity embedded in artifact'
    for identity in identities:
        out = os.path.join(tmp, 'out-%s' % os.path.basename(identity))
        module.age_decrypt(ciphertext, out, identity_file=identity)
        with open(out, 'rb') as handle:
            assert handle.read() == b'backup-payload'
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('dry-run plan lists components, destination and retention without mutations or credentials', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util
spec = importlib.util.spec_from_file_location('validator', 'scripts/validate-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
plan = module.build_dry_run_plan(
    components=['database', 'contracts'],
    destination='s3://bucket/backups',
    retention={'keepDays': 30, 'delete': ['s3://bucket/backups/old.tar.gz']},
    credentials={'AWS_SECRET_ACCESS_KEY': 'super-secret', 'AGE_IDENTITY': 'AGE-SECRET-KEY-1'},
)
assert plan['dryRun'] is True, plan
assert plan['components'] == ['database', 'contracts'], plan
assert plan['destination'] == 's3://bucket/backups', plan
assert plan['retention']['keepDays'] == 30, plan
assert plan['retention']['delete'] == ['s3://bucket/backups/old.tar.gz'], plan
assert plan['mutations'] == [], plan
rendered = module.render_dry_run_plan(plan)
assert 'super-secret' not in rendered, rendered
assert 'AGE-SECRET-KEY-1' not in rendered, rendered
assert 'database' in rendered and 'contracts' in rendered, rendered
assert 's3://bucket/backups' in rendered, rendered
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