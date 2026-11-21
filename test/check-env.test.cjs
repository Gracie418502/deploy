'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const checkEnv = import('../scripts/check-env.js');

test('parseEnvFile reads export assignments, quoted values and inline comments', async () => {
  const { parseEnvFile } = await checkEnv;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-env-test-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(
    file,
    '# ignored\n' +
      'export PLAIN=value # comment\n' +
      'export DOUBLE="two # still value" # comment\n' +
      "export SINGLE='three # still value' # comment\n" +
      'export CODE=$(not-executed)\n'
  );

  try {
    assert.deepEqual(parseEnvFile(file), {
      PLAIN: 'value',
      DOUBLE: 'two # still value',
      SINGLE: 'three # still value',
      CODE: '$(not-executed)',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs accepts equals syntax and rejects unknown or valueless options', async () => {
  const { parseArgs, run } = await checkEnv;

  assert.deepEqual(parseArgs(['--target=k8s', '--env-file=dev.env']), {
    target: 'k8s',
    envFile: 'dev.env',
    help: false,
  });
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
  assert.throws(() => parseArgs(['--target']), /requires a value/);
  assert.throws(() => parseArgs(['--env-file=']), /requires a value/);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(run(['--unknown']), 1);
    assert.equal(run(['--target=compsoe']), 1);
    assert.equal(run(['--env-file']), 1);
    assert.match(errors[0], /unknown argument/);
    assert.match(errors[1], /unknown target/);
    assert.match(errors[2], /requires a value/);
  } finally {
    console.error = originalError;
  }
});

test('validateEnv enforces target-specific URL protocols and parses URL syntax', async () => {
  const { validateEnv } = await checkEnv;
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const urlSpec = [{ name: 'SUPABASE_URL', description: 'Supabase URL' }];
    assert.equal(
      validateEnv(urlSpec, { SUPABASE_URL: 'http://localhost:54321' }, 'compose').ok,
      true
    );
    assert.deepEqual(
      validateEnv(urlSpec, { SUPABASE_URL: 'http://localhost:54321' }, 'k8s').invalidUrl,
      ['SUPABASE_URL']
    );
    assert.deepEqual(
      validateEnv(urlSpec, { SUPABASE_URL: 'javascript:alert(1)' }, 'compose').invalidUrl,
      ['SUPABASE_URL']
    );
    assert.deepEqual(validateEnv(urlSpec, { SUPABASE_URL: 'not a URL' }, 'compose').invalidUrl, [
      'SUPABASE_URL',
    ]);
    assert.equal(
      validateEnv(
        [{ name: 'DATABASE_URL', description: 'Database URL' }],
        { DATABASE_URL: 'postgresql://user:pass@localhost:5432/app' },
        'railway'
      ).ok,
      true
    );
  } finally {
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
