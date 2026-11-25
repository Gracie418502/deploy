# Upload sanitized diagnostics on deployment failure (#159)

## Summary

Failed rollouts left no diagnostic trail. The workflow now always collects pod status, events and migration Job state on
failure and uploads them as an artifact, after sanitizing secrets and environment values.

## What changed

- **`scripts/collect-diagnostics.sh`** (new) — captures `get pods -o wide`, pod YAML, events, the `backend-migrate` Job
  and deployments into `deploy-diagnostics/`, piping everything through the sanitizer; never fails the already-failed
  job.
- **`scripts/sanitize-diagnostics.mjs`** (new) — drops Kubernetes Secret objects, redacts sensitive env values
  (PASSWORD/TOKEN/KEY/DSN/etc.), Secret data maps and URL credentials, while keeping non-sensitive values.
- **`.github/workflows/deploy-k8s.yml`** — `if: failure()` steps collect and upload the artifact
  (`deploy-diagnostics-<env>-<run>-<attempt>`).
- **`test/failure-diagnostics.test.cjs`** (new) — verifies Secret removal, env redaction, retention of harmless values
  and that the collector produces all expected files with fake `kubectl`.
- **`docs/DEPLOY-KUBERNETES.md`** — documents the artifact and redaction rules.

## Acceptance criteria addressed

- Diagnostics are always uploaded on a failed rollout/smoke check.
- Secret resources and env values are excluded/redacted; pod status, events and migration Job status are included.

## Validation

`node --test test/failure-diagnostics.test.cjs` → 2 passed; workflow YAML parsed successfully.

closes #159
