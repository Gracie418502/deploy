# Validate repository_dispatch refs before building (#155)

## Summary

The deployment docs promised `repository_dispatch` support, but the workflow had no such trigger and would pass
untrusted `client_payload` refs straight to `actions/checkout`. Dispatch refs are now explicitly validated before any
checkout or build.

## What changed

- **`.github/workflows/deploy-k8s.yml`** — added the `repository_dispatch` trigger for `app-deploy`; the ref-loading step
  now passes the payload through the validator via an env var (no shell interpolation) and overrides the pinned refs only
  after validation.
- **`scripts/validate-dispatch-refs.mjs`** (new) — accepts only full SHAs or `refs/heads/…` / `refs/tags/…` values, and
  only `SynapsVault/backend` / `SynapsVault/frontend` as source repositories; emits accepted refs for the workflow and
  records them as `accepted_refs`.
- **`test/validate-dispatch-refs.test.cjs`** (new) — covers SHAs, defaults, malformed/path-traversal refs and unpermitted
  repositories.
- **`docs/DEPLOY-KUBERNETES.md`** — documents the payload fields, validation rules and that accepted refs/resolved SHAs
  appear in the release manifest.

## Acceptance criteria addressed

- Malformed payloads are rejected before checkout/builds.
- Accepted resolved revisions are recorded (release manifest `sources.*.ref` / `.sha` plus `accepted_refs` output).

## Validation

`node --test test/validate-dispatch-refs.test.cjs` → 4 passed.

closes #155
