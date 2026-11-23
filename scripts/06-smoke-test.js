/**
 * SynapsVault — Step 6: End-to-end smoke test
 *
 * Checks every critical path before submitting to SCF:
 *   ✓ Backend health
 *   ✓ Registry on-chain count
 *   ✓ Catalog returns resources (captures a real resource ID)
 *   ✓ x402 paywall returns 402 on unauthenticated access to a real resource
 *   ✓ Admin stats endpoint rejects unauthenticated requests and succeeds with valid key
 *   ✓ OpenAPI docs served
 *
 * Usage:
 *   BACKEND_URL=https://your-app.railway.app \
 *   ADMIN_API_KEY=your_admin_key \
 *   node scripts/06-smoke-test.js
 *
 * The base URL may be passed as the first CLI argument (e.g. from CI):
 *   node scripts/06-smoke-test.js "$DEPLOY_URL/api"
 *
 * Optional flags:
 *   --frontend-url <url>   Fetch <url>/config.js and verify the frontend is
 *                          configured for the expected network and API base.
 *   --report <path>        Write a machine-readable JSON report of all checks
 *                          (name, duration, result, sanitized error).
 *
 * Environment:
 *   EXPECTED_NETWORK       Expected Stellar network for registry/frontend
 *                          checks (default: "testnet").
 *   EXPECTED_CONTRACT_ID   Expected registry contract ID (optional).
 *   EXPECTED_API_BASE      Expected API base URL in the frontend config
 *                          (default: the smoke-test BASE URL).
 */

function parseArgs(argv) {
  const opts = { base: null, frontendUrl: null, reportPath: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--frontend-url") {
      opts.frontendUrl = argv[++i] ?? null;
    } else if (arg.startsWith("--frontend-url=")) {
      opts.frontendUrl = arg.slice("--frontend-url=".length);
    } else if (arg === "--report") {
      opts.reportPath = argv[++i] ?? null;
    } else if (arg.startsWith("--report=")) {
      opts.reportPath = arg.slice("--report=".length);
    } else {
      rest.push(arg);
    }
  }
  opts.base = rest[0] ?? null;
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));
const BASE = OPTS.base ?? process.env.BACKEND_URL ?? "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "change_me";
const EXPECTED_NETWORK = (process.env.EXPECTED_NETWORK ?? "testnet").toLowerCase();
const EXPECTED_CONTRACT_ID = process.env.EXPECTED_CONTRACT_ID ?? null;
const EXPECTED_API_BASE = process.env.EXPECTED_API_BASE ?? BASE;

// When run against a freshly started docker-compose stack, services may still
// be warming up even after `docker compose up -d --wait`. Allow a bounded
// retry window so CI smoke tests are not flaky on cold starts.
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 60000);
const READY_INTERVAL_MS = 2000;

let passed = 0;
let failed = 0;
const reportEntries = [];

// Strip anything that could leak credentials (admin keys, tokens, secrets)
// from error messages before they are printed or written to the report.
function sanitize(message) {
  let out = String(message ?? "");
  const secrets = [ADMIN_KEY, process.env.ADMIN_API_KEY].filter(
    (s) => typeof s === "string" && s.length > 0
  );
  for (const secret of secrets) {
    out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(/(X-Admin-Key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[REDACTED]");
  out = out.replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[REDACTED]");
  return out;
}

async function check(label, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    console.log(`  ✅ ${label}${result ? `  →  ${result}` : ""}`);
    passed++;
    reportEntries.push({ name: label, durationMs, status: "passed", result: result ?? null, error: null });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = sanitize(err?.message ?? err);
    console.error(`  ❌ ${label}  →  ${message}`);
    failed++;
    reportEntries.push({ name: label, durationMs, status: "failed", result: null, error: message });
  }
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HTTP ${res.status} — response is not valid JSON`);
  }
  return { res, body };
}

async function waitForBackend() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  throw new Error(
    `Backend not ready at ${BASE}/health within ${READY_TIMEOUT_MS}ms` +
      (lastErr ? ` (last error: ${lastErr.message})` : "")
  );
}

console.log(`\n▸ SynapsVault smoke test — ${BASE}\n`);

// Wait for the stack to accept traffic before running checks.
try {
  await waitForBackend();
} catch (err) {
  console.error(`  ❌ ${err.message}`);
  process.exit(1);
}

// Health — require HTTP 200 plus the documented healthy state.
await check("Backend health", async () => {
  const { res, body } = await getJson("/health");
  if (res.status !== 200) {
    throw new Error(`Expected HTTP 200 from /health, got ${res.status}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Malformed /health payload: expected a JSON object");
  }
  if (!("status" in body)) {
    throw new Error("Malformed /health payload: missing 'status' field");
  }
  const status = String(body.status).toLowerCase();
  if (status !== "ok" && status !== "healthy") {
    throw new Error(`Health status is '${body.status}' (expected 'ok'/'healthy') — service is degraded`);
  }
  return `status=${body.status}`;
});

// Registry — validate payload shape, counts, and contract/network identity.
await check("On-chain registry reachable", async () => {
  const { res, body: d } = await getJson("/registry/status");
  if (res.status !== 200) {
    throw new Error(`Expected HTTP 200 from /registry/status, got ${res.status}`);
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    throw new Error("Malformed /registry/status payload: expected a JSON object");
  }

  const count = d.resourceCount ?? d.count;
  if (count === undefined || count === null) {
    throw new Error("Malformed /registry/status payload: missing resourceCount");
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(`Malformed resourceCount: expected a non-negative integer, got ${JSON.stringify(count)}`);
  }

  const network = d.network ?? d.networkPassphrase ?? d.network_passphrase;
  if (network !== undefined && network !== null) {
    const actual = String(network).toLowerCase();
    if (!actual.includes(EXPECTED_NETWORK)) {
      throw new Error(
        `Registry network mismatch: expected '${EXPECTED_NETWORK}', got '${network}'`
      );
    }
  }

  const contractId = d.contractId ?? d.contract_id ?? d.contract;
  if (contractId !== undefined && contractId !== null) {
    if (typeof contractId !== "string" || !/^C[A-Z2-7]{55}$/.test(contractId)) {
      throw new Error(`Malformed contractId in /registry/status: ${JSON.stringify(contractId)}`);
    }
    if (EXPECTED_CONTRACT_ID && contractId !== EXPECTED_CONTRACT_ID) {
      throw new Error(
        `Registry contract mismatch: expected '${EXPECTED_CONTRACT_ID}', got '${contractId}'`
      );
    }
  } else if (EXPECTED_CONTRACT_ID) {
    throw new Error("Registry status does not expose a contractId to verify against EXPECTED_CONTRACT_ID");
  }

  const identity = contractId ? `, contract=${contractId}` : "";
  return `${count} resources registered${identity}`;
});

// Catalog — capture a real resource ID for the paywall check
let sampleResourceId = null;
await check("Catalog returns resources", async () => {
  const d = await get("/resources");
  const items = d.resources ?? d.data ?? d;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Expected at least 1 resource in catalog, got 0");
  }
  sampleResourceId = items[0]?.id ?? null;
  if (!sampleResourceId) {
    throw new Error("First catalog resource is missing an id field");
  }
  return `${items.length} item(s) (sample id=${sampleResourceId})`;
});

// Paywall — expect 402 against a real catalog resource ID
await check("x402 paywall blocks unauthenticated access", async () => {
  if (!sampleResourceId) {
    throw new Error("Cannot test paywall: no real resource ID available from catalog");
  }
  const res = await fetch(`${BASE}/resources/${encodeURIComponent(sampleResourceId)}`, {
    redirect: "manual",
  });
  if (res.status !== 402)
    throw new Error(`Expected 402 for resource ${sampleResourceId}, got ${res.status}`);
  return `resource ${sampleResourceId} returns 402 as expected`;
});

// Admin stats — verify unauthenticated access is rejected AND authenticated access works
await check("Admin stats endpoint protected", async () => {
  const unauthRes = await fetch(`${BASE}/admin/stats`);
  if (unauthRes.status !== 401 && unauthRes.status !== 403) {
    throw new Error(`Expected 401/403 without X-Admin-Key, got ${unauthRes.status}`);
  }

  const badKeyRes = await fetch(`${BASE}/admin/stats`, {
    headers: { "X-Admin-Key": `${ADMIN_KEY}-invalid` },
  });
  if (badKeyRes.status !== 401 && badKeyRes.status !== 403) {
    throw new Error(`Expected 401/403 with invalid X-Admin-Key, got ${badKeyRes.status}`);
  }

  const res = await fetch(`${BASE}/admin/stats`, {
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  if (!res.ok) throw new Error(`Authenticated request failed with HTTP ${res.status}`);
  const d = await res.json();
  return `unauth=${unauthRes.status}, auth=200 (resources=${d.resources}, publishers=${d.publishers})`;
});

// OpenAPI docs
await check("OpenAPI docs served", async () => {
  const res = await fetch(`${BASE}/docs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return "Swagger UI reachable";
});

// Frontend runtime config — optional, verifies the deployed frontend points at
// the expected network and API base (detects wrong-environment deployments).
if (OPTS.frontendUrl) {
  await check("Frontend runtime config matches deployment", async () => {
    const configUrl = `${OPTS.frontendUrl.replace(/\/+$/, "")}/config.js`;
    const res = await fetch(configUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${configUrl}`);
    const text = await res.text();

    const readValue = (key) => {
      const re = new RegExp(`${key}\\s*[:=]\\s*["']([^"']*)["']`);
      const m = text.match(re);
      return m ? m[1] : null;
    };

    const network = readValue("network") ?? readValue("NETWORK");
    if (!network) {
      throw new Error("Frontend config.js does not expose a network value");
    }
    if (!network.toLowerCase().includes(EXPECTED_NETWORK)) {
      throw new Error(
        `Frontend network mismatch: expected '${EXPECTED_NETWORK}', got '${network}'`
      );
    }

    const apiBase = readValue("apiBase") ?? readValue("API_BASE") ?? readValue("apiUrl");
    if (!apiBase) {
      throw new Error("Frontend config.js does not expose an API base URL");
    }
    const normalize = (u) => u.replace(/\/+$/, "");
    if (normalize(apiBase) !== normalize(EXPECTED_API_BASE)) {
      throw new Error(
        `Frontend API base mismatch: expected '${EXPECTED_API_BASE}', got '${apiBase}'`
      );
    }

    return `network=${network}, apiBase=${apiBase}`;
  });
}

// Summary
console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed  /  ${failed} failed`);

// Optional machine-readable report.
if (OPTS.reportPath) {
  const { writeFileSync } = await import("node:fs");
  const report = {
    baseUrl: BASE,
    frontendUrl: OPTS.frontendUrl ?? null,
    expectedNetwork: EXPECTED_NETWORK,
    timestamp: new Date().toISOString(),
    passed,
    failed,
    checks: reportEntries,
  };
  try {
    writeFileSync(OPTS.reportPath, JSON.stringify(report, null, 2));
    console.log(`  📄 Report written to ${OPTS.reportPath}`);
  } catch (err) {
    console.error(`  ⚠  Failed to write report: ${sanitize(err.message)}`);
    failed++;
  }
}

if (failed === 0) {
  console.log("\n  🎉 All checks passed — ready for SCF submission!\n");
} else {
  console.log("\n  ⚠  Fix the failures above before submitting.\n");
  process.exit(1);
}
