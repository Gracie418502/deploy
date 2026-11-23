# Dependency Inventory

This document lists the operational dependencies required to deploy and run the service, the responsible owner or role for each, and the escalation references to use when a dependency fails. It also defines the review cadence for keeping this inventory current.

Ownership is mapped from `.github/CODEOWNERS`. Alert routing and on-call escalation paths are defined in `docs/MONITORING.md`.

## Deployment Dependencies

| Dependency | Purpose | Owner / Role | Failure Escalation Reference |
| --- | --- | --- | --- |
| RPC providers | Blockchain RPC access for reads/writes and health checks | Platform / Infrastructure team (see `.github/CODEOWNERS`) | On-call via `docs/MONITORING.md`; provider status/support pages |
| Database / Supabase | Primary data store, migrations, and connection pooling | Backend / Data team (see `.github/CODEOWNERS`) | On-call via `docs/MONITORING.md`; Supabase support |
| Object storage | Artifact, backup, and static asset storage | Platform / Infrastructure team (see `.github/CODEOWNERS`) | On-call via `docs/MONITORING.md`; storage provider support |
| Container registry | Image storage and pull for deployments | Platform / Infrastructure team (see `.github/CODEOWNERS`) | On-call via `docs/MONITORING.md`; registry provider support |
| DNS | Domain resolution and traffic routing | Platform / Infrastructure team (see `.github/CODEOWNERS`) | On-call via `docs/MONITORING.md`; DNS provider support |
| Certificate issuance (cert-manager) | TLS certificate provisioning and renewal | Platform / Infrastructure team (see `.github/CODEOWNERS`) | On-call via `docs/MONITORING.md`; ACME/CA and cert-manager issue tracker |

## Ownership Mapping

- Team ownership and review responsibilities are defined in `.github/CODEOWNERS`. Update that file first when ownership changes, then reflect the change here.
- If a dependency has no clear owner in `.github/CODEOWNERS`, escalate to the Platform / Infrastructure team lead until ownership is assigned.

## Escalation

- Primary escalation path: on-call rotation and alert routing documented in `docs/MONITORING.md`.
- Provider-level outages: follow the provider status page and support channel listed above, and notify on-call so incident tracking can begin.
- Cross-team incidents: page the owning team via the escalation references in `docs/MONITORING.md`.

## Review Cadence

- Review this inventory **quarterly**, and additionally after any of the following:
  - A change to `.github/CODEOWNERS` or team structure.
  - Onboarding or replacing a provider (RPC, database, storage, registry, DNS, certificates).
  - A dependency-related incident or postmortem.
- The reviewer confirms each dependency still has a named owner and a valid escalation reference, and updates `docs/MONITORING.md` if alert routing has changed.