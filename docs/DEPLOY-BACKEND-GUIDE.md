# SynapsVault Backend — Deployment Guide

> **This file has been consolidated into the canonical Railway deployment guide.**
>
> Please read: **[docs/railway-deploy.md](./railway-deploy.md)**
>
> That guide covers everything that was previously in this file:
> - Supabase project setup (database + storage bucket)
> - Railway project creation (dashboard and CLI)
> - Environment variable reference (required and optional)
> - Running database migrations
> - Verifying the deployment
> - Connecting the Vercel frontend
> - Seeding the catalog
> - Costs, troubleshooting, and monitoring links

Keeping a single canonical guide avoids the differing instructions that
previously existed between this file, `docs/railway-deploy.md`, and
`README.md`. All three now point to `docs/railway-deploy.md`.

## Smoke-test configuration requirements

The post-deployment smoke test (`scripts/06-smoke-test.js`) validates its
configuration **before making any network calls**. If any of the checks below
fail, the script exits with a redacted configuration error so you can fix the
environment without leaking secrets into logs.

### `SMOKE_READY_TIMEOUT_MS`

- Must be a **finite, positive** number of milliseconds.
- Nonfinite values (`NaN`, `Infinity`), negative values, and zero are rejected
  with a configuration error before any requests are sent.
- Example: `SMOKE_READY_TIMEOUT_MS=30000`

### `ADMIN_API_KEY`

- Must be set **explicitly**; the script no longer silently falls back to
  `change_me`.
- Placeholder values (such as `change_me`) are rejected.
- Missing or placeholder keys produce an early, redacted configuration error.
- The key is never printed in full in error output.

### Base URL normalization

- The base URL is parsed and normalized before endpoint paths are joined, so a
  trailing slash does not produce double-slash requests.
- Both a root base URL (e.g. `https://api.example.com`) and an `/api` base path
  (e.g. `https://api.example.com/api`) are supported, and the intended route
  prefix is preserved when joining endpoint paths.

### Redirect policy for authenticated checks

- Authenticated endpoint checks use an explicit redirect policy.
- A cross-origin redirect **fails** the check without forwarding the
  `X-Admin-Key` header to the redirected origin, so admin credentials are never
  sent to a different host.