# Environment Variables

This document is the reference for every environment variable used by the
backend, the frontend, and the Kubernetes deployment manifests
(`k8s/configmap.yaml`, `k8s/secrets.yaml`). Names here match what the backend
code actually reads — `.env.example` and the manifests must stay in sync with
this list.

## Stellar / Soroban

| Variable | Secret | Description |
| --- | --- | --- |
| `STELLAR_NETWORK` | no | Supported network name: `testnet` or `mainnet` (case-insensitive). Any other value is rejected by `npm run check:env`. |
| `STELLAR_RPC_URL` | no | Soroban RPC endpoint (e.g. `https://soroban-testnet.stellar.org`). |
| `STELLAR_HORIZON_URL` | no | Horizon endpoint used for account / payment lookups. |
| `STELLAR_NETWORK_PASSPHRASE` | no | Network passphrase matching `STELLAR_NETWORK`. |
| `STELLAR_PUBLIC_KEY` | no | Stellar account public key (`G...`) for the deployment signer. When `STELLAR_SECRET_KEY` is also set, the two must match. |
| `STELLAR_SECRET_KEY` | **yes** | Stellar secret key (`S...`) used by the deployment signer. |
| `STELLAR_AGENT_CONTRACT_ID` | no | Contract ID of the agent registry contract. |
| `STELLAR_REGISTRY_CONTRACT_ID` | no | Contract ID of the registry contract. |
| `STELLAR_ESCROW_CONTRACT_ID` | no | Contract ID of the escrow contract. |
| `USDC_CONTRACT_ID` | no | Contract ID of the USDC token contract. |
| `AGENT_SECRET_KEY` | **yes** | Stellar secret key (`S...`) used by the agent signer. |
| `REGISTRY_SECRET_KEY` | **yes** | Stellar secret key (`S...`) used by the registry signer. |

## Supabase

| Variable | Secret | Description |
| --- | --- | --- |
| `SUPABASE_URL` | no | Supabase project URL. |
| `SUPABASE_ANON_KEY` | no | Supabase anon/public key (safe for the frontend). |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase service role key (backend only). |

## LLM providers

| Variable | Secret | Description |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | **yes** | OpenRouter API key used by the agent runtime. |
| `OPENROUTER_MODEL` | no | Default model identifier (optional). |

## Application

| Variable | Secret | Description |
| --- | --- | --- |
| `NODE_ENV` | no | `development` / `production`. |
| `PORT` | no | HTTP port the backend listens on. |
| `LOG_LEVEL` | no | Log verbosity (`debug`, `info`, `warn`, `error`). |
| `CORS_ORIGIN` | no | Allowed frontend origin(s). |
| `NEXT_PUBLIC_API_URL` | no | Backend base URL consumed by the frontend. |

## Frontend runtime config

These variables are read by the frontend container entrypoint at startup and
rendered into `/config.js`, which the browser loads before the app bundle.

| Variable | Secret | Description |
| --- | --- | --- |
| `APP_API_URL` | no | Backend base URL used by the frontend. Accepts a relative path starting with `/` (e.g. `/api`) or an absolute `http://` / `https://` URL. |
| `APP_NETWORK` | no | Stellar network the frontend targets. Must be one of the supported network names (`testnet`, `mainnet`). |
| `APP_SENTRY_DSN` | no | Optional Sentry DSN for frontend error reporting. Leave empty to disable. |

Validation rules:

- `APP_API_URL` and `APP_NETWORK` are required. If either is missing or
  invalid, the container exits at startup with a field-level message naming the
  offending variable (e.g. `APP_API_URL must be a relative path starting with
  "/" or an absolute http(s) URL`).
- `APP_SENTRY_DSN` is optional; when set it must be a valid `http(s)` URL.
- Values are escaped when rendered into `/config.js`, so quotes, backslashes,
  line breaks and script-like strings are preserved as string literals and
  cannot break out of the generated JavaScript.

## Notes

- Secret values live only in `k8s/secrets.yaml` (or your secret manager) and
  must never be committed with real values.
- Non-secret values live in `k8s/configmap.yaml` and `.env.example`.
- When adding a variable, update the backend reader, `.env.example`,
  `k8s/configmap.yaml` / `k8s/secrets.yaml`, and this document together.

## Stellar value validation in deployment checks

`npm run check:env` validates the Stellar settings before a deployment is
accepted:

- **Network names.** `STELLAR_NETWORK` must be one of the supported network
  names (`testnet`, `mainnet`). Unsupported values are rejected with an error
  that lists the accepted names instead of being treated as valid.
- **StrKey checksums.** Declared account public keys (`STELLAR_PUBLIC_KEY`),
  signing keys (`STELLAR_SECRET_KEY`, `AGENT_SECRET_KEY`,
  `REGISTRY_SECRET_KEY`) and contract IDs (`STELLAR_AGENT_CONTRACT_ID`,
  `STELLAR_REGISTRY_CONTRACT_ID`, `STELLAR_ESCROW_CONTRACT_ID`,
  `USDC_CONTRACT_ID`) are validated with the Stellar SDK's StrKey checksum
  validation. Strings with a wrong prefix or a corrupted checksum are rejected.
- **Public / secret key cross-check.** When both `STELLAR_PUBLIC_KEY` and
  `STELLAR_SECRET_KEY` are supplied, the public key is derived from the secret
  key and compared with `STELLAR_PUBLIC_KEY`. A mismatch fails the check.
- **Blank values.** Required settings that are empty or contain only whitespace
  (including quoted whitespace such as `"   "`) are treated as missing before
  any semantic validation runs. Values that are non-blank are used verbatim, so
  secrets that intentionally contain spaces are not altered.
- **Redaction.** Secret values are never printed in diagnostics. Errors name the
  offending variable and describe the problem without echoing the value, and
  derived key material is not shown either.

## URL validation in deployment checks

`npm run check:env` parses URL-valued settings and applies protocol rules for
each deployment target. The Compose target accepts `http://` and `https://`
for `SOROBAN_RPC_URL` and `SUPABASE_URL`, including local development endpoints
such as `http://localhost:54321`. Kubernetes and Railway require HTTPS for
those two endpoints. Railway's `DATABASE_URL` must use `postgres://` or
`postgresql://`.

## Duplicate keys in env files

`npm run check:env` also scans the env file it loads (`.env` by default, or the
file passed via `--env-file`) for duplicate assignments. The policy is
deterministic:

- **Last assignment wins.** When a key is assigned more than once in the file,
  the value from the last assignment is the one used for validation.
- **`process.env` takes precedence.** A key already present in `process.env`
  overrides every assignment in the file, regardless of position.
- **Duplicates are reported with line numbers.** Each duplicate key is listed
  with the line numbers of all its assignments (e.g. `APP_NETWORK assigned on
  lines 3, 12`) so accidental shadowing is visible. The report names keys and
  line numbers only — never values.

Duplicate keys are reported as warnings; they do not by themselves fail the
check. Use the report to remove accidental shadowing from your env files.

## JSON output mode

Pass `--json` to emit a machine-readable result instead of human-readable text:

```bash
npm run check:env -- --target kubernetes --json
```

The JSON object contains:

- `target` — the deployment target that was validated.
- `ok` — whether validation passed.
- `errors` — a list of `{ code, variable, message }` entries, where `code` is a
  stable error identifier and `variable` names the affected setting.
- `warnings` — the same shape, used for non-fatal findings such as duplicate
  keys.

JSON mode never includes secret values: only variable names, error codes and
messages are emitted. Exit codes are unchanged — `0` when validation passes and
non-zero when it fails — so JSON mode can be used in CI scripts that branch on
the exit status.

## Strict mainnet mode

Pass `--strict` (or `--mainnet`) to enable production checks. In this mode the
validator additionally rejects:

- **Testnet configuration** — `STELLAR_NETWORK` / `APP_NETWORK` must be
  `mainnet`; testnet identifiers are reported as errors.
- **Insecure remote endpoints** — `http://` URLs for RPC, Horizon, Supabase or
  API endpoints are rejected unless the host is local (`localhost`, `127.0.0.1`
  or `::1`), so local development endpoints remain usable.

Without `--strict`, normal local validation is unchanged and remains usable for
development. Use `--strict` in production deployment pipelines:

```bash
npm run check:env -- --target kubernetes --strict
```
## Smoke-test configuration

`scripts/06-smoke-test.js` validates its configuration before making any
network calls. Invalid settings fail fast with a redacted configuration error
(secret values are never echoed).

| Variable | Secret | Description |
| --- | --- | --- |
| `SMOKE_BASE_URL` | no | Base URL of the deployed backend. Parsed and normalized, so a trailing slash does not produce double-slash requests. A root base URL (`https://api.example.com`) and a path prefix (`https://api.example.com/api`) are both supported; the prefix is preserved when endpoint paths are joined. |
| `SMOKE_READY_TIMEOUT_MS` | no | Readiness polling timeout in milliseconds. Must be a finite, positive number; nonfinite, negative and zero values are rejected. |
| `ADMIN_API_KEY` | **yes** | Admin API key used for authenticated endpoint checks. Must be explicitly set and must not be a placeholder (e.g. `change_me`); missing or placeholder values are rejected. |

Authenticated endpoint checks use an explicit redirect policy: redirects are
not followed across origins. A cross-origin redirect fails the check without
forwarding the `X-Admin-Key` header to the redirected origin.
