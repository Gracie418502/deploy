# Operational runbooks

Alert-specific runbooks live in this directory. Use the table below to find the
runbook that matches the situation, and cross-reference the linked alert
description and the monitoring troubleshooting guidance in
[`docs/MONITORING.md`](../MONITORING.md) where relevant.

| Runbook | Purpose |
| --- | --- |
| [`stellar-testnet-reset.md`](stellar-testnet-reset.md) | Coordinated recovery after a Stellar testnet reset: account funding, contract redeployment, backend catalog reconciliation, and a verification checklist for stale contract IDs and network-derived data. |
| [`database-expand-and-contract.md`](database-expand-and-contract.md) | Expand-and-contract schema release sequencing for rolling deployments, including a worked example with rollout, rollback boundary, and delayed destructive migration. |
| [`kubernetes-node-drain-drill.md`](kubernetes-node-drain-drill.md) | Repeatable staging drill that drains a node while observing availability and scheduling, with expected disruption-budget behavior, recovery timing, and cleanup steps. |

When adding a new runbook, add a row to this table so operators can discover it.

## Runbook index

| Runbook | Use when | Location |
| --- | --- | --- |
| Backup and restore | Taking backups, pruning old backups, restoring data, or configuring object-storage credential scopes (upload, pruning, restore) | [`docs/BACKUP-RESTORE.md`](../BACKUP-RESTORE.md) |
| Release compatibility matrix | Verifying which backend, frontend and contract revisions work together, or updating the matrix for a release | [`docs/RELEASE-COMPATIBILITY.md`](../RELEASE-COMPATIBILITY.md) |
| Database rollback and interrupted migration recovery | A database migration was interrupted or failed and you must decide whether to retry, repair or restore before resuming traffic | [`docs/DATABASE-ROLLBACK.md`](../DATABASE-ROLLBACK.md) |
| Operational dependency inventory | Identifying deployment dependencies, their owners or roles, and failure escalation references | [`docs/DEPENDENCY-INVENTORY.md`](../DEPENDENCY-INVENTORY.md) |

## Notes

- The backup and restore runbook documents least-privilege object-storage
  credential scopes that distinguish upload, pruning and restore access, plus
  provider-specific permission verification steps. Never embed actual
  credentials in runbooks or tickets.
- The release compatibility matrix records verified backend, frontend and
  contract revisions and links each release to its deployment evidence.
- The database rollback runbook explains how to inspect migration state and
  decide whether to retry, repair or restore after an interruption, including a
  staging exercise and explicit checks before application traffic resumes.
- The dependency inventory covers RPC, database, object storage, container
  registry, DNS and certificate issuance, with owners and a documented review
  cadence.
