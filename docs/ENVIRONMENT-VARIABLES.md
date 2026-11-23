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
