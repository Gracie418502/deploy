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
</content>