# Release Compatibility Matrix

This document tracks the backend, frontend, and contract revisions that have been
verified to work together. It is the authoritative record of which combinations of
components are known-good for a release.

## Purpose

Deployments involve three independently versioned components:

- **Backend** — the API / indexer service.
- **Frontend** — the web application.
- **Contracts** — the on-chain smart contracts (identified by contract IDs and the
  commit that produced them).

Because these components are released on different cadences, we maintain a matrix
of combinations that have been verified together. A combination is only listed once
it has deployment evidence (a CI run, a deployment record, or a linked PR).

## Compatibility Matrix

| Backend ref | Frontend ref | Contract IDs / commit | Verification date | Status | Evidence |
|-------------|--------------|-----------------------|-------------------|--------|----------|
| _TBD_       | _TBD_        | _TBD_                 | _TBD_             | _TBD_  | _TBD_    |

### Column definitions

- **Backend ref** — Git ref (tag, commit SHA, or branch) of the backend that was
  deployed and verified. Prefer an immutable tag or full commit SHA.
- **Frontend ref** — Git ref of the frontend that was deployed and verified.
- **Contract IDs / commit** — The deployed contract IDs for each network plus the
  contract source commit that produced them. Reference the `contract-ids-<network>`
  artifact from the `deploy-contracts` workflow.
- **Verification date** — Date (UTC, `YYYY-MM-DD`) on which the combination was
  verified end-to-end.
- **Status** — One of:
  - `verified` — deployed and confirmed working together.
  - `candidate` — deployed but verification in progress.
  - `deprecated` — previously verified but superseded; kept for history.
  - `broken` — known-incompatible; do not deploy together.
- **Evidence** — Link(s) to the deployment evidence: CI run URL, deployment
  record, and/or PR that introduced the combination.

## Sources of pinned refs

The pinned refs used for a release are defined in:

- **`.github/app-versions.yml`** — the human-editable source of truth for the
  backend and frontend refs pinned for a release.
- **`.github/workflows/app-versions.env`** — the environment file consumed by the
  workflows, derived from `app-versions.yml`.

When a release updates the pinned refs, the matrix must be updated to reflect the
new combination (see below).

## Deployment evidence

Contract deployment evidence is produced by the `deploy-contracts` workflow. Each
run uploads a `contract-ids-<network>` artifact (for example
`contract-ids-testnet`, `contract-ids-mainnet`) containing the deployed contract
IDs for that network. Link to the workflow run that produced the artifact, and
record the contract IDs and source commit in the matrix.

## How a release updates the matrix

When preparing or completing a release:

1. **Update pinned refs.** Edit `.github/app-versions.yml` with the backend and
   frontend refs for the release, and regenerate/commit
   `.github/workflows/app-versions.env` so the workflows consume the new pins.
2. **Deploy contracts (if changed).** Run the `deploy-contracts` workflow for the
   target network(s). Capture the run URL and the `contract-ids-<network>`
   artifact.
3. **Deploy backend and frontend** using the pinned refs from step 1.
4. **Verify** the combination end-to-end (smoke tests, health checks, and any
   release-specific verification).
5. **Add a row to the matrix** with:
   - the backend ref and frontend ref from `app-versions.yml`,
   - the contract IDs and source commit from the `contract-ids-<network>`
     artifact,
   - the verification date,
   - the status (`verified` once confirmed),
   - links to the evidence (see below).
6. **Mark superseded rows** as `deprecated` rather than deleting them, so the
   history of verified combinations is preserved.
7. **Open a PR** updating this document. The PR itself is part of the evidence
   trail; link it in the row's Evidence column.

## Linking evidence

Each matrix row's **Evidence** column should contain links to the artifacts that
prove the combination was verified. Use the following formats:

- **CI / workflow run URL** — link directly to the run, e.g.
  `https://github.com/<org>/<repo>/actions/runs/<run-id>`. For contract
  deployments, link the `deploy-contracts` run that produced the
  `contract-ids-<network>` artifact.
- **Deployment record** — link to the deployment dashboard, release notes, or
  deployment log entry for the backend and frontend deployments.
- **Pull request** — link the PR that updated this matrix (and/or the PRs that
  bumped the pinned refs), e.g. `https://github.com/<org>/<repo>/pull/<number>`.

Multiple links may be included in a single cell, separated by `<br>` or commas.
Prefer immutable links (run IDs, commit SHAs, PR numbers) over mutable branch
links.

### Example row

| Backend ref | Frontend ref | Contract IDs / commit | Verification date | Status | Evidence |
|-------------|--------------|-----------------------|-------------------|--------|----------|
| `v1.4.0` (`abc1234`) | `v1.3.2` (`def5678`) | testnet: `C...`; commit `9876fed` | 2025-01-15 | verified | [deploy-contracts run](https://github.com/org/repo/actions/runs/0000000000)<br>[matrix PR #123](https://github.com/org/repo/pull/123) |

## Maintenance

- Review the matrix as part of every release.
- Keep at least the current and previous verified combinations listed.
- If a combination is found to be broken after being marked `verified`, update its
  status to `broken` and add a note with the evidence and remediation.