# Bound Kubernetes deployment durations (#158)

## Summary

The deploy workflow had per-command kubectl timeouts but no job-level ceiling and several unbounded steps, so a stalled
job could run until GitHub's default limit. All steps and the job itself are now bounded, with a validator and tests that
prove an unbounded workflow is rejected.

## What changed

- **`.github/workflows/deploy-k8s.yml`** — `timeout-minutes: 30` on the deploy job and `timeout-minutes: 10` on every step.
- **`scripts/check-deploy-timeouts.mjs`** (new, `npm run check:deploy-timeouts`) — parses the workflow and fails if the
  job ceiling is missing/out of range or any step lacks a timeout.
- **`test/deploy-timeouts.test.cjs`** (new) — asserts the real workflow passes, and that removing either the job ceiling
  or step timeouts is rejected (demonstrating a stalled job cannot be left unbounded).
- **`docs/DEPLOY-KUBERNETES.md`** — documents the timeout budget and that app-repo build jobs need their own cap.

## Acceptance criteria addressed

- Bounded job and step durations in addition to per-command kubectl timeouts.
- Timeout budget documented; validator/tests demonstrate an unbounded step is rejected.

## Validation

`npm run check:deploy-timeouts` and `node --test test/deploy-timeouts.test.cjs` → 3 passed.

closes #158
