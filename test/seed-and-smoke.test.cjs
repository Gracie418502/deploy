'use strict';

// Unit tests for scripts/05-seed-catalog.js and scripts/06-smoke-test.js
// exercised end-to-end offline using test/friendbot-fetch-stub.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const http = require('http');
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

test('06-smoke-test.js exits 0 when all 6 checks pass', () => {
  const { status, stdout, requested } = runWithStub(SMOKE_SCRIPT, [
    { status: 200, json: { status: 'healthy' } },
    { status: 200, json: { status: 'healthy' } },
    { status: 200, json: { resourceCount: 3 } },
    { status: 200, json: { resources: [{ id: 'res-1' }, { id: 'res-2' }] } },
    { status: 402, json: { error: 'Payment Required' } },
    { status: 401, json: {} },
    { status: 403, json: {} },
    { status: 200, json: { resources: 2, publishers: 2 } },
    { status: 200, text: '<html>Swagger</html>' },
  ]);

  assert.equal(status, 0);
  assert.match(stdout, /6 passed  \/  0 failed/);
  assert.equal(requested.length, 9);
});

test('06-smoke-test.js exits nonzero within a bounded time when the server never responds', async () => {
  // A server that accepts TCP connections but never writes a response.
  const sockets = new Set();
  const server = http.createServer(() => {
    /* intentionally never respond */
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  const startedAt = Date.now();
  let status = 0;
  let stdout = '';
  let stderr = '';

  try {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [SMOKE_SCRIPT], {
        env: {
          ...process.env,
          BACKEND_URL: `http://127.0.0.1:${port}`,
          PUBLISHER1_PUBLIC: Keypair.random().publicKey(),
          PUBLISHER2_PUBLIC: Keypair.random().publicKey(),
          ADMIN_API_KEY: 'test-admin-key',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => {
        status = code ?? 1;
        resolve();
      });
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  const elapsedMs = Date.now() - startedAt;

  assert.notEqual(status, 0, 'smoke test should fail when the server never responds');
  // Bounded: every request must be aborted well before this generous ceiling.
  assert.ok(
    elapsedMs < 120000,
    `smoke test should finish within a bounded time, took ${elapsedMs}ms`
  );
  assert.match(stdout + stderr, /timed out|abort/i);
});

test('06-smoke-test.js exits 1 when paywall does not return 402', () => {
  const { status, stdout, stderr } = runWithStub(SMOKE_SCRIPT, [
    { status: 200, json: { status: 'healthy' } },
    { status: 200, json: { status: 'healthy' } },
    { status: 200, json: { resourceCount: 3 } },
    { status: 200, json: { resources: [{ id: 'res-1' }] } },
    { status: 200, json: { leaked: true } },
    { status: 401, json: {} },
    { status: 403, json: {} },
    { status: 200, json: { resources: 1, publishers: 1 } },
    { status: 200, text: '<html>Swagger</html>' },
  ]);

  assert.equal(status, 1);
  assert.match(stderr, /Expected 402 for resource res-1, got 200/);
  assert.match(stdout, /5 passed  \/  1 failed/);
});
