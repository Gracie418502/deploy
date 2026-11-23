'use strict';

// Unit tests for scripts/05-seed-catalog.js and scripts/06-smoke-test.js
// exercised end-to-end offline using test/friendbot-fetch-stub.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { Keypair } = require('@stellar/stellar-sdk');

const ROOT = path.resolve(__dirname, '..');
const SEED_SCRIPT = path.join(ROOT, 'scripts', '05-seed-catalog.js');
const SMOKE_SCRIPT = path.join(ROOT, 'scripts', '06-smoke-test.js');
const FETCH_STUB = path.join(__dirname, 'friendbot-fetch-stub.mjs');

function runWithStub(scriptPath, scenario, extraEnv = {}) {
  const log = path.join(
    os.tmpdir(),
    `script-stub-${process.pid}-${Math.random().toString(36).slice(2)}.log`
  );

  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(
      process.execPath,
      ['--import', pathToFileURL(FETCH_STUB).href, scriptPath],
      {
        env: {
          ...process.env,
          BACKEND_URL: 'http://stub.local:3000',
          PUBLISHER1_PUBLIC: Keypair.random().publicKey(),
          PUBLISHER2_PUBLIC: Keypair.random().publicKey(),
          ADMIN_API_KEY: 'test-admin-key',
          FRIENDBOT_STUB: JSON.stringify(scenario),
          FRIENDBOT_STUB_LOG: log,
          ...extraEnv,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (err) {
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }

  let requested = [];
  try {
    requested = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    /* stub was not called */
  }
  fs.rmSync(log, { force: true });

  return { status, stdout, stderr, requested };
}

test('05-seed-catalog.js creates publishers, publishes 3 resources, and verifies catalog', () => {
  const { status, stdout, requested } = runWithStub(SEED_SCRIPT, [
    { status: 200, json: { resources: [] } },
    { status: 200, json: { apiKey: 'pub1_api_key_123456' } },
    { status: 200, json: { apiKey: 'pub2_api_key_654321' } },
    { status: 200, json: { id: 'res-1', accessUrl: 'http://stub.local:3000/resources/res-1' } },
    { status: 200, json: { id: 'res-2', accessUrl: 'http://stub.local:3000/resources/res-2' } },
    { status: 200, json: { id: 'res-3', accessUrl: 'http://stub.local:3000/resources/res-3' } },
    { status: 200, json: { resources: [{ id: 'res-1' }, { id: 'res-2' }, { id: 'res-3' }] } },
  ]);

  assert.equal(status, 0);
  assert.match(stdout, /Catalog seeded ✅/);
  assert.match(stdout, /res-1/);
  assert.equal(requested.length, 7);
});

const HEALTHY = { status: 'healthy' };
const REGISTRY = { resources: 2, publishers: 2, network: 'testnet' };

function smokeScenario(overrides = {}) {
  return [
    { status: 200, json: HEALTHY },
    { status: 200, json: HEALTHY },
    { status: 200, json: { resourceCount: 3 } },
    { status: 200, json: { resources: [{ id: 'res-1' }, { id: 'res-2' }] } },
    { status: 402, json: { error: 'Payment Required' } },
    { status: 401, json: {} },
    { status: 403, json: {} },
    { status: 200, json: REGISTRY },
    { status: 200, text: '<html>Swagger</html>' },
    ...(overrides.tail ?? []),
  ];
}

test('06-smoke-test.js exits 0 when all 6 checks pass', () => {
  const { status, stdout, requested } = runWithStub(SMOKE_SCRIPT, smokeScenario());

  assert.equal(status, 0);
  assert.match(stdout, /6 passed  \/  0 failed/);
  assert.equal(requested.length, 9);
});

test('06-smoke-test.js exits 1 when paywall does not return 402', () => {
  const { status, stdout, stderr } = runWithStub(SMOKE_SCRIPT, [
    { status: 200, json: HEALTHY },
    { status: 200, json: HEALTHY },
    { status: 200, json: { resourceCount: 3 } },
    { status: 200, json: { resources: [{ id: 'res-1' }] } },
    { status: 200, json: { leaked: true } },
    { status: 401, json: {} },
    { status: 403, json: {} },
    { status: 200, json: { resources: 1, publishers: 1, network: 'testnet' } },
    { status: 200, text: '<html>Swagger</html>' },
  ]);

  assert.equal(status, 1);
  assert.match(stderr, /Expected 402 for resource res-1, got 200/);
  assert.match(stdout, /5 passed  \/  1 failed/);
});

test('06-smoke-test.js fails when health returns HTTP 200 with degraded status', () => {
  const scenario = smokeScenario();
  scenario[0] = { status: 200, json: { status: 'degraded' } };
  const { status, stdout, stderr } = runWithStub(SMOKE_SCRIPT, scenario);

  assert.equal(status, 1);
  assert.match(stderr, /health/i);
  assert.match(stderr, /degraded/);
  assert.match(stdout, /5 passed  \/  1 failed/);
});

test('06-smoke-test.js fails when health returns HTTP 200 with malformed payload', () => {
  const scenario = smokeScenario();
  scenario[0] = { status: 200, json: { ok: true } };
  const { status, stdout, stderr } = runWithStub(SMOKE_SCRIPT, scenario);

  assert.equal(status, 1);
  assert.match(stderr, /health/i);
  assert.match(stdout, /5 passed  \/  1 failed/);
});

test('06-smoke-test.js fails when registry counts are malformed', () => {
  const scenario = smokeScenario();
  scenario[7] = { status: 200, json: { resources: 'many', publishers: 2, network: 'testnet' } };
  const { status, stdout, stderr } = runWithStub(SMOKE_SCRIPT, scenario);

  assert.equal(status, 1);
  assert.match(stderr, /registry/i);
  assert.match(stdout, /5 passed  \/  1 failed/);
});

test('06-smoke-test.js fails when registry network is incompatible', () => {
  const scenario = smokeScenario();
  scenario[7] = { status: 200, json: { resources: 2, publishers: 2, network: 'mainnet' } };
  const { status, stdout, stderr } = runWithStub(SMOKE_SCRIPT, scenario, {
    EXPECTED_NETWORK: 'testnet',
  });

  assert.equal(status, 1);
  assert.match(stderr, /network/i);
  assert.match(stderr, /mainnet/);
  assert.match(stdout, /5 passed  \/  1 failed/);
});

test('06-smoke-test.js --report writes sanitized JSON and keeps nonzero exit on failure', () => {
  const reportPath = path.join(
    os.tmpdir(),
    `smoke-report-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
  const scenario = smokeScenario();
  scenario[4] = { status: 200, json: { leaked: true } };

  const { status } = runWithStub(SMOKE_SCRIPT, scenario, {
    SMOKE_REPORT_PATH: reportPath,
  });

  assert.equal(status, 1);
  const raw = fs.readFileSync(reportPath, 'utf8');
  fs.rmSync(reportPath, { force: true });

  assert.ok(!raw.includes('test-admin-key'), 'report must not contain admin credentials');
  const report = JSON.parse(raw);
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.length >= 6);
  for (const check of report.checks) {
    assert.equal(typeof check.name, 'string');
    assert.equal(typeof check.durationMs, 'number');
    assert.equal(typeof check.ok, 'boolean');
  }
  const failed = report.checks.filter((c) => !c.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /402/);
});

test('06-smoke-test.js --frontend-url passes when config.js matches expected network and API base', () => {
  const configJs = `window.APP_CONFIG = ${JSON.stringify({
    network: 'testnet',
    apiBase: 'http://stub.local:3000',
  })};`;
  const { status, stdout } = runWithStub(
    SMOKE_SCRIPT,
    smokeScenario({ tail: [{ status: 200, text: configJs }] }),
    {
      FRONTEND_URL: 'http://frontend.local',
      EXPECTED_NETWORK: 'testnet',
    }
  );

  assert.equal(status, 0);
  assert.match(stdout, /7 passed  \/  0 failed/);
});

test('06-smoke-test.js --frontend-url fails when config.js targets the wrong environment', () => {
  const configJs = `window.APP_CONFIG = ${JSON.stringify({
    network: 'mainnet',
    apiBase: 'https://api.example.org',
  })};`;
  const { status, stdout, stderr } = runWithStub(
    SMOKE_SCRIPT,
    smokeScenario({ tail: [{ status: 200, text: configJs }] }),
    {
      FRONTEND_URL: 'http://frontend.local',
      EXPECTED_NETWORK: 'testnet',
    }
  );

  assert.equal(status, 1);
  assert.match(stderr, /frontend/i);
  assert.match(stdout, /6 passed  \/  1 failed/);
test('06-smoke-test.js rejects invalid SMOKE_READY_TIMEOUT_MS before any network calls', () => {
  for (const value of ['NaN', 'Infinity', '-1', '0']) {
    const { status, stderr, requested } = runWithStub(
      SMOKE_SCRIPT,
      [],
      { SMOKE_READY_TIMEOUT_MS: value }
    );

    assert.equal(status, 1, `expected exit 1 for SMOKE_READY_TIMEOUT_MS=${value}`);
    assert.match(
      stderr,
      /SMOKE_READY_TIMEOUT_MS/,
      `expected configuration error mentioning SMOKE_READY_TIMEOUT_MS for ${value}`
    );
    assert.equal(
      requested.length,
      0,
      `expected no network calls for SMOKE_READY_TIMEOUT_MS=${value}`
    );
  }
});

test('06-smoke-test.js normalizes a root base URL without double slashes', () => {
  const { status, requested } = runWithStub(
    SMOKE_SCRIPT,
    [
      { status: 200, json: { status: 'healthy' } },
      { status: 200, json: { status: 'healthy' } },
      { status: 200, json: { resourceCount: 3 } },
      { status: 200, json: { resources: [{ id: 'res-1' }, { id: 'res-2' }] } },
      { status: 402, json: { error: 'Payment Required' } },
      { status: 401, json: {} },
      { status: 403, json: {} },
      { status: 200, json: { resources: 2, publishers: 2 } },
      { status: 200, text: '<html>Swagger</html>' },
    ],
    { BACKEND_URL: 'https://host/' }
  );

  assert.equal(status, 0);
  assert.ok(requested.length > 0);
  for (const url of requested) {
    assert.ok(
      !/https?:\/\/[^/]*\/\//.test(url),
      `expected no double slash in request URL: ${url}`
    );
  }
});

test('06-smoke-test.js preserves an /api base path prefix', () => {
  const { status, requested } = runWithStub(
    SMOKE_SCRIPT,
    [
      { status: 200, json: { status: 'healthy' } },
      { status: 200, json: { status: 'healthy' } },
      { status: 200, json: { resourceCount: 3 } },
      { status: 200, json: { resources: [{ id: 'res-1' }, { id: 'res-2' }] } },
      { status: 402, json: { error: 'Payment Required' } },
      { status: 401, json: {} },
      { status: 403, json: {} },
      { status: 200, json: { resources: 2, publishers: 2 } },
      { status: 200, text: '<html>Swagger</html>' },
    ],
    { BACKEND_URL: 'https://host/api/' }
  );

  assert.equal(status, 0);
  assert.ok(requested.length > 0);
  for (const url of requested) {
    assert.ok(
      !/https?:\/\/[^/]*\/\//.test(url),
      `expected no double slash in request URL: ${url}`
    );
    assert.ok(
      url.startsWith('https://host/api/'),
      `expected /api prefix preserved in request URL: ${url}`
    );
  }
});

test('06-smoke-test.js rejects missing and placeholder ADMIN_API_KEY before any network calls', () => {
  const cases = [
    { label: 'missing', env: { ADMIN_API_KEY: '' } },
    { label: 'placeholder', env: { ADMIN_API_KEY: 'change_me' } },
  ];

  for (const { label, env } of cases) {
    const { status, stderr, requested } = runWithStub(SMOKE_SCRIPT, [], env);

    assert.equal(status, 1, `expected exit 1 for ${label} ADMIN_API_KEY`);
    assert.match(
      stderr,
      /ADMIN_API_KEY/,
      `expected configuration error mentioning ADMIN_API_KEY for ${label} key`
    );
    assert.ok(
      !stderr.includes('change_me'),
      `expected redacted error for ${label} key, got: ${stderr}`
    );
    assert.equal(
      requested.length,
      0,
      `expected no network calls for ${label} ADMIN_API_KEY`
    );
  }
});

test('06-smoke-test.js fails cross-origin redirect without forwarding X-Admin-Key', () => {
  const { status, stderr, requested } = runWithStub(SMOKE_SCRIPT, [
    { status: 200, json: { status: 'healthy' } },
    { status: 200, json: { status: 'healthy' } },
    { status: 200, json: { resourceCount: 3 } },
    { status: 200, json: { resources: [{ id: 'res-1' }, { id: 'res-2' }] } },
    { status: 402, json: { error: 'Payment Required' } },
    {
      status: 302,
      headers: { location: 'https://evil.example.com/admin/stats' },
      json: {},
    },
    { status: 403, json: {} },
    { status: 200, json: { resources: 2, publishers: 2 } },
    { status: 200, text: '<html>Swagger</html>' },
  ]);

  assert.equal(status, 1);
  assert.match(stderr, /redirect/i);
  for (const url of requested) {
    assert.ok(
      !url.startsWith('https://evil.example.com'),
      `expected no request to redirected origin, got: ${url}`
    );
  }
});
