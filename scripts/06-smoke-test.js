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
 */

// ── Configuration validation (runs before any network calls) ────────────────

function configError(message) {
  console.error(`\n  ❌ Configuration error: ${message}\n`);
  process.exit(1);
}

// Base URL — parse and normalize so a trailing slash never produces `//`.
const RAW_BASE = process.argv[2] ?? process.env.BACKEND_URL ?? "http://localhost:3000";
let BASE;
try {
  const parsed = new URL(RAW_BASE);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    configError(`BACKEND_URL must use http or https, got "${parsed.protocol}"`);
  }
  // Strip trailing slashes from the pathname while preserving any prefix (e.g. /api).
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  BASE = parsed.toString().replace(/\/+$/, "");
} catch (err) {
  configError(`Invalid BACKEND_URL "${RAW_BASE}": ${err.message}`);
}

// Admin API key — must be explicitly provided and must not be a placeholder.
const PLACEHOLDER_KEYS = new Set([
  "change_me",
  "change-me",
  "change-me-to-a-long-random-string",
  "changeme",
  "your_admin_key",
  "admin",
  "test",
]);
const ADMIN_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_KEY || ADMIN_KEY.trim() === "") {
  configError("ADMIN_API_KEY is not set. Provide a real admin key via the environment.");
}
if (PLACEHOLDER_KEYS.has(ADMIN_KEY.trim().toLowerCase())) {
  configError(
    "ADMIN_API_KEY is set to a placeholder value. Provide a real admin key via the environment."
  );
}

// Readiness timeout — must be a finite, strictly positive number of milliseconds.
const RAW_TIMEOUT = process.env.SMOKE_READY_TIMEOUT_MS ?? "60000";
const READY_TIMEOUT_MS = Number(RAW_TIMEOUT);
if (!Number.isFinite(READY_TIMEOUT_MS)) {
  configError(`SMOKE_READY_TIMEOUT_MS must be a finite number, got "${RAW_TIMEOUT}"`);
}
if (READY_TIMEOUT_MS <= 0) {
  configError(`SMOKE_READY_TIMEOUT_MS must be greater than zero, got "${RAW_TIMEOUT}"`);
}
const READY_INTERVAL_MS = 2000;

// Join a normalized base URL with an endpoint path using exactly one slash.
function url(path) {
  return `${BASE}/${String(path).replace(/^\/+/, "")}`;
}

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${label}${result ? `  →  ${result}` : ""}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}  →  ${err.message}`);
    failed++;
  }
}

async function get(path, headers = {}) {
  const res = await fetch(url(path), { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function waitForBackend() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url("/health"));
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  throw new Error(
    `Backend not ready at ${url("/health")} within ${READY_TIMEOUT_MS}ms` +
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

// Health
await check("Backend health", async () => {
  const d = await get("/health");
  return d.status ?? "ok";
});

// Registry
await check("On-chain registry reachable", async () => {
  const d = await get("/registry/status");
  return `${d.resourceCount ?? 0} resources registered`;
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
  const res = await fetch(url(`/resources/${encodeURIComponent(sampleResourceId)}`), {
    redirect: "manual",
  });
  if (res.status !== 402)
    throw new Error(`Expected 402 for resource ${sampleResourceId}, got ${res.status}`);
  return `resource ${sampleResourceId} returns 402 as expected`;
});

// Admin stats — verify unauthenticated access is rejected AND authenticated access works
await check("Admin stats endpoint protected", async () => {
  const unauthRes = await fetch(url("/admin/stats"), { redirect: "manual" });
  if (unauthRes.status !== 401 && unauthRes.status !== 403) {
    throw new Error(`Expected 401/403 without X-Admin-Key, got ${unauthRes.status}`);
  }

  const badKeyRes = await fetch(url("/admin/stats"), {
    headers: { "X-Admin-Key": `${ADMIN_KEY}-invalid` },
    redirect: "manual",
  });
  if (badKeyRes.status !== 401 && badKeyRes.status !== 403) {
    throw new Error(`Expected 401/403 with invalid X-Admin-Key, got ${badKeyRes.status}`);
  }

  // Authenticated request: never follow redirects automatically. If the server
  // redirects cross-origin, fail without re-sending X-Admin-Key to that origin.
  const res = await fetch(url("/admin/stats"), {
    headers: { "X-Admin-Key": ADMIN_KEY },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`Authenticated request redirected (HTTP ${res.status}) without a Location header`);
    }
    let target;
    try {
      target = new URL(location, url("/admin/stats"));
    } catch (err) {
      throw new Error(`Authenticated request redirected to an invalid Location "${location}"`);
    }
    if (target.origin !== new URL(BASE).origin) {
      throw new Error(
        `Authenticated request redirected cross-origin to ${target.origin}; refusing to forward X-Admin-Key`
      );
    }
    throw new Error(`Authenticated request redirected (HTTP ${res.status}) to ${target.pathname}`);
  }
  if (!res.ok) throw new Error(`Authenticated request failed with HTTP ${res.status}`);
  const d = await res.json();
  return `unauth=${unauthRes.status}, auth=200 (resources=${d.resources}, publishers=${d.publishers})`;
});

// OpenAPI docs
await check("OpenAPI docs served", async () => {
  const res = await fetch(url("/docs"));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return "Swagger UI reachable";
});

// Summary
console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed} passed  /  ${failed} failed`);
if (failed === 0) {
  console.log("\n  🎉 All checks passed — ready for SCF submission!\n");
} else {
  console.log("\n  ⚠  Fix the failures above before submitting.\n");
  process.exit(1);
}
