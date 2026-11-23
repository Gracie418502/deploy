'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const checkEnv = import('../scripts/check-env.js');
const StellarSdk = require('@stellar/stellar-sdk');

const { Keypair, StrKey } = StellarSdk;

function corruptChecksum(value) {
  const last = value[value.length - 1];
  const replacement = last === 'A' ? 'B' : 'A';
  return value.slice(0, -1) + replacement;
}

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

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

test('parseEnvFile reports duplicate assignments with line numbers and applies last-wins', async () => {
  const { parseEnvFile } = await checkEnv;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-env-test-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(
    file,
    '# header\n' +
      'export DUP=first\n' +
      'OTHER=value\n' +
      'export DUP=second\n' +
      'DUP=third\n'
  );

  try {
    const result = parseEnvFile(file, { withDuplicates: true });
    assert.equal(result.values.DUP, 'third');
    assert.equal(result.values.OTHER, 'value');
    assert.deepEqual(result.duplicates, [
      { key: 'DUP', lines: [2, 4, 5] },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateEnv keeps process.env precedence over env file values', async () => {
  const { validateEnv } = await checkEnv;
  const previous = process.env.CHECK_ENV_PRECEDENCE;
  process.env.CHECK_ENV_PRECEDENCE = 'from-process';
  try {
    const spec = [{ name: 'CHECK_ENV_PRECEDENCE', description: 'Precedence probe' }];
    const result = validateEnv(spec, { CHECK_ENV_PRECEDENCE: 'from-file' }, 'compose');
    assert.equal(result.ok, true);
    assert.equal(result.values.CHECK_ENV_PRECEDENCE, 'from-process');
  } finally {
    if (previous === undefined) delete process.env.CHECK_ENV_PRECEDENCE;
    else process.env.CHECK_ENV_PRECEDENCE = previous;
  }
});

test('run --json emits valid JSON with target, error codes and variable names only', async () => {
  const { run } = await checkEnv;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-env-test-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'SUPABASE_URL=not a URL\n');

  const previousSupabaseUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const chunks = [];
  const originalLog = console.log;
  console.log = (...args) => chunks.push(args.join(' '));
  try {
    const code = run(['--target=compose', `--env-file=${file}`, '--json']);
    assert.equal(code, 1);
    const payload = JSON.parse(chunks.join('\n'));
    assert.equal(payload.target, 'compose');
    assert.equal(payload.ok, false);
    assert.ok(Array.isArray(payload.errors));
    const codes = payload.errors.map((e) => e.code);
    assert.ok(codes.includes('INVALID_URL'));
    const names = payload.errors.flatMap((e) => e.variables || []);
    assert.ok(names.includes('SUPABASE_URL'));
    assert.equal(JSON.stringify(payload).includes('not a URL'), false);
  } finally {
    console.log = originalLog;
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run --json exits zero for a valid environment', async () => {
  const { run } = await checkEnv;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-env-test-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'SUPABASE_URL=http://localhost:54321\n');

  const previousSupabaseUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const chunks = [];
  const originalLog = console.log;
  console.log = (...args) => chunks.push(args.join(' '));
  try {
    const code = run(['--target=compose', `--env-file=${file}`, '--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(chunks.join('\n'));
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.errors, []);
  } finally {
    console.log = originalLog;
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict mainnet mode rejects testnet identifiers and insecure remote endpoints', async () => {
  const { validateEnv } = await checkEnv;
  const spec = [
    { name: 'SUPABASE_URL', description: 'Supabase URL' },
    { name: 'STELLAR_NETWORK', description: 'Network' },
  ];

  const testnet = validateEnv(
    spec,
    { SUPABASE_URL: 'https://example.supabase.co', STELLAR_NETWORK: 'testnet' },
    'k8s',
    { strict: true }
  );
  assert.equal(testnet.ok, false);
  assert.ok(testnet.errors.some((e) => e.code === 'TESTNET_CONFIG'));

  const insecure = validateEnv(
    spec,
    { SUPABASE_URL: 'http://example.supabase.co', STELLAR_NETWORK: 'mainnet' },
    'k8s',
    { strict: true }
  );
  assert.equal(insecure.ok, false);
  assert.ok(insecure.errors.some((e) => e.code === 'INSECURE_ENDPOINT'));

  const local = validateEnv(
    spec,
    { SUPABASE_URL: 'http://localhost:54321', STELLAR_NETWORK: 'testnet' },
    'compose'
  );
  assert.equal(local.ok, true);
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

test('validateEnv accepts testnet and mainnet STELLAR_NETWORK values', async () => {
  const { validateEnv } = await checkEnv;
  const spec = [{ name: 'STELLAR_NETWORK', description: 'Stellar network' }];

  for (const network of ['testnet', 'mainnet']) {
    const result = validateEnv(spec, { STELLAR_NETWORK: network }, 'compose');
    assert.equal(result.ok, true, `${network} should be accepted`);
    assert.deepEqual(result.invalidNetwork || [], []);
  }
});

test('validateEnv rejects unsupported STELLAR_NETWORK values with an actionable error', async () => {
  const { validateEnv } = await checkEnv;
  const spec = [{ name: 'STELLAR_NETWORK', description: 'Stellar network' }];

  for (const network of ['futurenet', 'Testnet', 'main-net', 'public']) {
    const result = validateEnv(spec, { STELLAR_NETWORK: network }, 'compose');
    assert.equal(result.ok, false, `${network} should be rejected`);
    assert.deepEqual(result.invalidNetwork, ['STELLAR_NETWORK']);
    const message = (result.errors || []).join('\n');
    assert.match(message, /STELLAR_NETWORK/);
    assert.match(message, /testnet/);
    assert.match(message, /mainnet/);
  }
});

test('validateEnv accepts valid StrKey account, signing key and contract ID values', async () => {
  const { validateEnv } = await checkEnv;
  const keypair = Keypair.random();
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const spec = [
    { name: 'STELLAR_PUBLIC_KEY', description: 'Stellar public key', secret: false },
    { name: 'STELLAR_SECRET_KEY', description: 'Stellar secret key', secret: true },
    { name: 'CONTRACT_ID', description: 'Contract ID', secret: false },
  ];

  const result = validateEnv(
    spec,
    {
      STELLAR_PUBLIC_KEY: keypair.publicKey(),
      STELLAR_SECRET_KEY: keypair.secret(),
      CONTRACT_ID: contractId,
    },
    'compose'
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.invalidStrKey || [], []);
});

test('validateEnv rejects checksum-invalid StrKey values', async () => {
  const { validateEnv } = await checkEnv;
  const keypair = Keypair.random();
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const spec = [
    { name: 'STELLAR_PUBLIC_KEY', description: 'Stellar public key', secret: false },
    { name: 'STELLAR_SECRET_KEY', description: 'Stellar secret key', secret: true },
    { name: 'CONTRACT_ID', description: 'Contract ID', secret: false },
  ];

  const result = validateEnv(
    spec,
    {
      STELLAR_PUBLIC_KEY: corruptChecksum(keypair.publicKey()),
      STELLAR_SECRET_KEY: corruptChecksum(keypair.secret()),
      CONTRACT_ID: corruptChecksum(contractId),
    },
    'compose'
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalidStrKey, [
    'STELLAR_PUBLIC_KEY',
    'STELLAR_SECRET_KEY',
    'CONTRACT_ID',
  ]);
});

test('validateEnv redacts signing key values in every diagnostic', async () => {
  const { validateEnv } = await checkEnv;
  const keypair = Keypair.random();
  const secret = keypair.secret();
  const spec = [
    { name: 'STELLAR_SECRET_KEY', description: 'Stellar secret key', secret: true },
  ];

  const result = validateEnv(spec, { STELLAR_SECRET_KEY: corruptChecksum(secret) }, 'compose');
  assert.equal(result.ok, false);
  const message = (result.errors || []).join('\n');
  assert.doesNotMatch(message, new RegExp(secret));
  assert.doesNotMatch(message, new RegExp(corruptChecksum(secret)));
  assert.match(message, /STELLAR_SECRET_KEY/);
});

test('validateEnv accepts matching STELLAR_SECRET_KEY and STELLAR_PUBLIC_KEY', async () => {
  const { validateEnv } = await checkEnv;
  const keypair = Keypair.random();
  const spec = [
    { name: 'STELLAR_PUBLIC_KEY', description: 'Stellar public key', secret: false },
    { name: 'STELLAR_SECRET_KEY', description: 'Stellar secret key', secret: true },
  ];

  const result = validateEnv(
    spec,
    { STELLAR_PUBLIC_KEY: keypair.publicKey(), STELLAR_SECRET_KEY: keypair.secret() },
    'compose'
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.keyMismatch || [], []);
});

test('validateEnv rejects mismatched STELLAR_SECRET_KEY and STELLAR_PUBLIC_KEY without leaking material', async () => {
  const { validateEnv } = await checkEnv;
  const keypair = Keypair.random();
  const other = Keypair.random();
  const spec = [
    { name: 'STELLAR_PUBLIC_KEY', description: 'Stellar public key', secret: false },
    { name: 'STELLAR_SECRET_KEY', description: 'Stellar secret key', secret: true },
  ];

  const result = validateEnv(
    spec,
    { STELLAR_PUBLIC_KEY: other.publicKey(), STELLAR_SECRET_KEY: keypair.secret() },
    'compose'
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.keyMismatch, ['STELLAR_PUBLIC_KEY', 'STELLAR_SECRET_KEY']);
  const message = (result.errors || []).join('\n');
  assert.doesNotMatch(message, new RegExp(keypair.secret()));
  assert.doesNotMatch(message, new RegExp(keypair.publicKey()));
  assert.doesNotMatch(message, new RegExp(other.publicKey()));
});

test('validateEnv treats blank, whitespace-only and quoted-whitespace required values as missing', async () => {
  const { validateEnv } = await checkEnv;
  const spec = [{ name: 'STELLAR_NETWORK', description: 'Stellar network' }];

  for (const value of ['', '   ', '\t', '\n', '""', "''", '  ""  ', "  ''  "]) {
    const result = validateEnv(spec, { STELLAR_NETWORK: value }, 'compose');
    assert.equal(result.ok, false, `value ${JSON.stringify(value)} should be missing`);
    assert.deepEqual(result.missing, ['STELLAR_NETWORK']);
  }
});

test('validateEnv preserves valid values that intentionally contain internal spaces', async () => {
  const { validateEnv } = await checkEnv;
  const spec = [{ name: 'CUSTOM_LABEL', description: 'Custom label' }];

  const result = validateEnv(spec, { CUSTOM_LABEL: 'my label value' }, 'compose');
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing || [], []);
});

test('run reports unsupported STELLAR_NETWORK without leaking secrets', async () => {
  const keypair = Keypair.random();
  const { result, errors } = withEnv(
    {
      STELLAR_NETWORK: 'futurenet',
      STELLAR_PUBLIC_KEY: keypair.publicKey(),
      STELLAR_SECRET_KEY: keypair.secret(),
    },
    () => captureConsole(() => checkEnv.then((mod) => mod.run(['--target=compose'])))
  );
  const code = await result;
  assert.equal(code, 1);
  const message = errors.join('\n');
  assert.match(message, /STELLAR_NETWORK/);
  assert.doesNotMatch(message, new RegExp(keypair.secret()));
});
