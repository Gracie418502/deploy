# Backup and Restore Runbook

This runbook describes how backups are taken, where they are stored, how long they are retained, and how to restore the system in the event of data loss or corruption.

## 0. PostgreSQL Version Alignment

All environments run **PostgreSQL 17**:

| Environment | Version | Where |
| --- | --- | --- |
| Local dev | 17 | `docker-compose.yml` (`postgres:17`) |
| Production / Supabase | 17 | Supabase project (Postgres 17) |
| Backup / restore client | 17 | `.github/workflows/backup.yml` (`postgres:17` image) |

**Why:** `pg_dump` output from a newer major version cannot be restored into an older server. Keeping the backup client, local dev and production on the same major version (17) guarantees that dumps taken in CI restore cleanly into local dev and production, and vice versa. When upgrading Postgres, bump all three together.

## 1. Scope

The following data is backed up:

| Component | Description | Backup Method |
| --- | --- | --- |
| PostgreSQL database | Primary application database (users, transactions, metadata) | `pg_dump` logical backup |
| Contract state | Soroban RPC snapshots of configured contract instances | `getContractData` via `scripts/backup.sh` |

> **Note:** Secret values are **not** included in backups. Secrets are managed separately via the secrets manager and must be re-provisioned during restore.

## 2. Backup Schedule

| Job | Schedule | What it does |
| --- | --- | --- |
| Backup | Daily at 02:00 UTC | `scripts/backup.sh`: `pg_dump` + contract state snapshot → encrypted archive + manifest in object storage |
| Restore verification | Sundays at 04:00 UTC | `scripts/restore.sh --verify-only` against staging: restores the newest backup into a throwaway database and checks every table came back |

Both run from [`.github/workflows/backup.yml`](../.github/workflows/backup.yml) and can also be started manually (**Run workflow** → `backup`, `verify-restore` or `both`). Until the required secrets are configured, the jobs are skipped with a warning instead of failing.

### Required configuration

Repository secrets:

| Secret | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | backup | Production database to dump |
| `STAGING_DATABASE_URL` | verify-restore | Staging database; the role needs `CREATEDB` |
| `BACKUP_ENCRYPTION_KEY` | both | gpg passphrase used to encrypt/decrypt archives |
| `BACKUP_STORAGE_BUCKET` | both | Bucket name |
| `BACKUP_STORAGE_ACCESS_KEY_ID`, `BACKUP_STORAGE_SECRET_ACCESS_KEY` | both | S3-compatible credentials |
| `BACKUP_STORAGE_REGION` | both | Optional, default `us-east-1` |
| `BACKUP_STORAGE_ENDPOINT` | both | Optional, for non-AWS S3 (R2, MinIO, Supabase's S3 endpoint, ...) |

Optional repository variables for the contract-state snapshot: `SOROBAN_RPC_URL`, `SOROBAN_NETWORK_PASSPHRASE`, `SOROBAN_CONTRACT_IDS` (comma-separated).

Optional tuning variables for network calls (both `backup.sh` and `restore.sh`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_RPC_TIMEOUT_SECONDS` | `30` | Per-attempt deadline for each Soroban RPC call |
| `BACKUP_STORAGE_TIMEOUT_SECONDS` | `60` | Per-attempt deadline for each object-storage (S3) call |
| `BACKUP_RETRY_MAX_ATTEMPTS` | `4` | Total attempts (initial try + retries) for transient failures |
| `BACKUP_RETRY_BASE_DELAY_SECONDS` | `2` | Base delay for exponential backoff between attempts (capped) |

### Network deadlines and retries

Every RPC and object-storage call is bounded by a deadline (`timeout`/`--cli-read-timeout` for `aws`, `curl --max-time` for RPC) so a hung endpoint cannot stall a backup or restore indefinitely. Transient failures — timeouts, connection resets, HTTP 429/5xx, and S3 `RequestTimeout`/`SlowDown`/`InternalError` responses — are retried with exponential backoff up to `BACKUP_RETRY_MAX_ATTEMPTS` total attempts.

Non-transient failures are **not** retried: invalid or expired credentials (HTTP 401/403, S3 `AccessDenied`/`InvalidAccessKeyId`/`SignatureDoesNotMatch`/`ExpiredToken`), missing buckets or objects (404/`NoSuchBucket`/`NoSuchKey`), and malformed requests fail immediately with a clear error. This prevents lockouts and wasted time when the credentials themselves are wrong; fix the credentials and re-run.

### Backup layout

Each run writes two objects under `s3://<bucket>/backups/`:

- `soroban-backup-<UTC timestamp>.tar.gz.enc` — encrypted tarball containing `database.sql.gz` (plain SQL with `DROP ... IF EXISTS`), `tables.txt` (table list used for verification) and `contracts/` (contract state snapshots, when configured).
- `soroban-backup-<UTC timestamp>.manifest.json` — a copy is uploaded as a workflow artifact. It contains:
  - `schemaVersion` — manifest schema version (currently `1`).
  - `timestamp`, `size`, `encryption` method and source metadata.
  - `archiveSha256` — SHA-256 of the encrypted archive.
  - `components` — per-component SHA-256 checksums recorded before encryption: `database.sql.gz`, `tables.txt` and each file under `contracts/`.
  - `postgres` — `serverVersion` (from `SHOW server_version`) and `pgDumpVersion` (from `pg_dump --version`).

### Manifest schema and compatibility policy

The manifest declares a `schemaVersion`. `restore.sh` validates the manifest before touching the target database: required fields must be present and correctly typed, and the `schemaVersion` must be one it supports (currently `1`). Unsupported or newer schema versions are rejected with a clear error before any download or restore work begins, so an old `restore.sh` never misinterprets a newer manifest.

Compatibility policy:

- Adding optional fields is backward compatible and does not bump `schemaVersion`.
- Removing or changing the meaning/type of an existing field bumps `schemaVersion`.
- `restore.sh` accepts only schema versions it explicitly knows; to restore a backup written by a newer `backup.sh`, use a `restore.sh` from the same or a newer release.
- Manifests without `schemaVersion` (written before versioning) are treated as legacy and rejected by current `restore.sh`; restore them with the release that produced them.

### PostgreSQL version metadata and restore compatibility

The manifest records both the PostgreSQL **server** version and the **`pg_dump` client** version used to produce the dump. Before restoring, compare them with the target server:

- A dump taken by a `pg_dump` **newer** than the target server major version cannot be restored reliably — restore into a server at least as new as the recorded `pgDumpVersion`, or use a backup taken with a matching client.
- A dump taken by a `pg_dump` **older** than the target server is generally restorable, but review release notes for the major version jump.
- If `serverVersion` and `pgDumpVersion` differ in major version, treat the backup as suspect and prefer one where they match (see section 0).
=======

## 3. Retention Policy

- Backups are retained according to the lifecycle policy on the backup bucket (recommended: 30 days for daily backups). The scripts never delete old backups.
- Workflow artifacts (manifests) are kept for 30 days.

## 4. Encryption

- Archives are encrypted client-side before upload: with gpg (AES-256, symmetric passphrase from `BACKUP_ENCRYPTION_KEY`) by default, or with [age](https://age-encryption.org) when `BACKUP_ENCRYPTION_KEY` is an `age1...` recipient or a recipients file. `backup.sh` refuses to fall back to unencrypted uploads; plaintext requires an explicit `BACKUP_ENCRYPTION_METHOD=none`.
- Uploads use TLS. Enable server-side encryption on the bucket as an additional layer.
- Access to the backup bucket should be restricted to the backup credentials and on-call engineers via least-privilege policies.

## 5. Storage Locations

| Environment | Bucket | Region |
| --- | --- | --- |
| Production | `s3://prod-backups-<org>/` | `us-east-1` |
| Staging | `s3://staging-backups-<org>/` | `us-east-1` |
| Development | `s3://dev-backups-<org>/` | `us-east-1` |

## 6. RTO / RPO Targets

| Metric | Target | Notes |
| --- | --- | --- |
| **RPO** (Recovery Point Objective) | 24 hours (logical) / 2 minutes (Supabase PITR) | Daily full `pg_dump` + continuous WAL archiving when PITR is enabled |
| **RTO** (Recovery Time Objective) | 4 hours | Maximum acceptable downtime |

### 6.1 Supabase Point-in-Time Recovery (PITR) vs. Logical `pg_dump` Backups

When hosting PostgreSQL on Supabase in production, enable **Supabase Point-in-Time Recovery (PITR)** alongside the daily encrypted `pg_dump` archives produced by `scripts/backup.sh`:

| Capability | Daily `pg_dump` (`scripts/backup.sh`) | Supabase PITR (Physical + WAL) |
| --- | --- | --- |
| **Granularity (RPO)** | 24 hours (02:00 UTC snapshot) | Up to **2 minutes** (any second within retention window) |
| **Storage Independence** | Independent S3 / R2 / MinIO bucket with client-side `gpg`/`age` encryption | Managed inside Supabase infrastructure (S3 + WALG) |
| **Contract State Included** | Yes (`contracts/` Soroban RPC snapshots + `manifest.json`) | No (database only) |
| **Staging Verification** | Automated weekly via `scripts/restore.sh --verify-only` | Manual clone/restore via Supabase Dashboard or Management API |

#### When to use which:
1. **Accidental table drop, bad migration, or data corruption within the last 7–28 days**:
   - Use **Supabase PITR** (Dashboard → **Database** → **Backups** → **Point in Time** → select the exact UTC timestamp immediately before the incident) to minimize data loss to `< 2 minutes`.
   - After PITR finishes, inspect the latest `soroban-backup-*.manifest.json` from object storage if you also need to cross-check on-chain contract IDs.
2. **Provider outage, region migration, or compliance archive recovery**:
   - Use `scripts/restore.sh` with the encrypted `pg_dump` archive stored in your external bucket (`BACKUP_STORAGE_BUCKET`) to restore into any standard PostgreSQL 15/17 instance.

## 7. Restore Procedure

### 7.1 Prerequisites

- `aws` CLI, `psql`, `gpg` (or `age`), `tar`, `gzip`, `sha256sum`.
- Access to the backup bucket and the encryption key.
- A target PostgreSQL instance with sufficient capacity.

`scripts/restore.sh` reads the same `BACKUP_STORAGE_*` and `BACKUP_ENCRYPTION_KEY` variables as `backup.sh` (for age-encrypted backups, set `BACKUP_AGE_IDENTITY_FILE` instead).

### 7.2 Steps

1. **Identify the backup to restore.**
   ```bash
   aws s3 ls s3://<backup-bucket>/backups/ | grep manifest | tail -n 5
   ```
   Pick the newest backup that precedes the incident. If you omit `--backup`, `restore.sh` uses the newest one.

2. **Rehearse against a scratch database (recommended).**
   ```bash
   ./scripts/restore.sh --backup soroban-backup-<timestamp> --verify-only \
     --database-url postgresql://<user>:<pass>@<staging-host>:5432/postgres
   ```

3. **Restore into the target database.**
   ```bash
   ./scripts/restore.sh --backup soroban-backup-<timestamp> --database-url "$DATABASE_URL"
   ```
   The script downloads the manifest and archive, validates the manifest schema version and required fields, verifies the archive SHA-256, decrypts, then verifies each component checksum from `components` against the decrypted files before replaying the dump in a single transaction (a failed restore changes nothing). Objects in the target that are not in the backup are left in place. If the manifest's `postgres` versions are incompatible with the target server, the script warns (or aborts with `--verify-only`) before applying anything.

   Before any destructive SQL is applied, `restore.sh` runs two pre-flight checks against the target (see sections 7.5 and 7.6): a PostgreSQL **extension inventory** comparison and a **lock/statement timeout** policy. Both produce actionable diagnostics and abort the restore before the transaction starts when they fail.

4. **Inspect contract state snapshots (if needed).** Add `--keep-work-dir` to keep the extracted `contracts/` snapshots. On-chain state cannot be "restored"; use the snapshots to confirm which contract IDs the application should point at, and use `scripts/rollback-contracts.cjs` to repoint it.

5. **Re-provision secrets.** Retrieve the required secrets from the secrets manager and inject them into the restored environment. Do **not** restore secrets from backups.

6. **Run migrations (if the backup predates the current release).** The Kubernetes `migrate` initContainer does this on the next rollout, or run it manually:
   ```bash
   kubectl -n synapsvault rollout restart deployment/backend
   ```

7. **Restart application services** against the restored database.

### 7.3 Verification

After restore, verify the following:

- [ ] `restore.sh` finished with `restore complete` (exit code 0).
- [ ] Row counts for critical tables look plausible (`--verify-only` logs counts for every table).
- [ ] Critical-table counts are within the expected counts/bounds recorded in the backup (see section 7.7); the restore fails verification otherwise.
- [ ] The sanitized audit report (section 7.8) was produced and, in CI, uploaded as an artifact.
- [ ] The application's `/health` endpoint reports healthy.
- [ ] Smoke tests pass (`BACKEND_URL=... npm run test:smoke`).
- [ ] No errors in application logs for 15 minutes post-restore.
- [ ] RTO/RPO targets were met (record actual times).

### 7.4 Rollback

If the restore fails, `restore.sh` rolls its transaction back and exits non-zero (2 = download/manifest validation/checksum, 3 = decryption or component checksum mismatch, 4 = restore, 5 = verification). Fix the cause and re-run, or re-attempt with an earlier backup. If the failure is an unsupported manifest `schemaVersion`, use a `restore.sh` from the matching or newer release. Document the failure and notify the on-call engineer.

### 7.5 Pre-flight: PostgreSQL extension check

Before applying any SQL, `restore.sh` inventories the extensions the backup requires and compares them with what the target can provide:

- **Required extensions** are read from the backup (the `extensions` list recorded in the manifest, falling back to `CREATE EXTENSION` statements in the dump). If neither is available, the check is skipped with a warning.
- **Availability** is checked against `pg_available_extensions` on the target.
- **Permissions** are checked by confirming the restore role can create extensions (`rolsuper` or `CREATEROLE`/`CREATE` on the database), since `CREATE EXTENSION` runs as part of the restore.

Diagnostics list each missing or uncreatable extension by name with the reason (not available on the target, or insufficient privileges) and the suggested remedy (install the `postgresql-<major>-<extension>` package, enable it on the managed provider, or restore with a role that can create extensions). Any missing extension aborts the restore **before** the transaction begins, so no destructive SQL is applied. Set `RESTORE_SKIP_EXTENSION_CHECK=1` only when you have verified the target manually.

### 7.6 Pre-flight: lock and statement timeout policy

To keep an unattended restore from waiting indefinitely on a conflicting session, `restore.sh` sets a bounded timeout policy on its restore session:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RESTORE_LOCK_TIMEOUT` | `30s` | `lock_timeout` for the restore session; a lock wait longer than this fails the statement |
| `RESTORE_STATEMENT_TIMEOUT` | `0` (disabled) | `statement_timeout` for the restore session; `0` disables it so long `COPY`/index builds are not killed |
| `RESTORE_LOCK_RETRY_ATTEMPTS` | `3` | Attempts to acquire the lock before giving up |
| `RESTORE_LOCK_RETRY_DELAY_SECONDS` | `10` | Delay between lock-acquisition attempts |

Values use PostgreSQL timeout syntax (`ms`, `s`, `min`). When a lock cannot be acquired within the policy, the restore aborts with a diagnostic naming the blocking session (from `pg_stat_activity`/`pg_locks`) so the operator can terminate it and re-run. The policy is applied with `SET` on the restore session only and does not change server-wide settings.

### 7.7 Critical-table row-count verification

`backup.sh` records expected row counts for a configurable list of critical tables in the manifest (`criticalTables`), so a restore can catch missing critical data even when every expected table name exists:

- **Configuring the list:** set `BACKUP_CRITICAL_TABLES` to a comma-separated list of tables, optionally with bounds, e.g. `users,transactions:min=1000,ledger_entries:min=1:max=10000000`. A bare table name records the exact count at backup time; `min=`/`max=` record bounds instead.
- **Recorded at backup time:** for each entry, `backup.sh` records the table name, the observed count and the expected count or bounds in the manifest's `criticalTables` array.
- **Verified at restore time:** after the dump is replayed (and in `--verify-only` mode), `restore.sh` counts each listed table on the target and compares it with the recorded expectation. A count outside the recorded bounds, or a missing table, fails verification with exit code 5 and a per-table diagnostic (expected vs. actual).
- **Overriding at restore time:** pass `--critical-tables <list>` (same syntax) to check a different list, or `--skip-critical-tables` to bypass the check when the manifest has no recorded list.

### 7.8 Sanitized restore audit report

Every `restore.sh` run writes a sanitized JSON audit report (default `restore-audit-<UTC timestamp>.json` in the working directory; override with `--audit-report <path>`). It records:

- `backupId` — the backup identifier restored.
- `target` — the target identity: host, port, database and role (never the password; connection URLs are redacted).
- `timestamps` — `startedAt`, `finishedAt` and `durationSeconds`.
- `components` — per-component outcome (manifest, archive checksum, decryption, component checksums, dump replay) with `status` and detail.
- `verification` — results of the extension check, lock/timeout policy, PostgreSQL version compatibility and critical-table row-count verification.
- `result` — overall `success`/`failure` and the exit code.

The report never contains connection passwords, encryption keys or other secrets; connection strings are reduced to host/port/database/role. It is written even when the restore fails, so it can be attached to an incident.

In CI, the `verify-restore` job uploads the report as an artifact:

```yaml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: restore-audit
    path: restore-audit-*.json
    retention-days: 30
```

Locally, upload it manually if needed: `aws s3 cp restore-audit-*.json s3://<bucket>/restore-audits/`.

## 8. Testing

- Restores are verified automatically **weekly** against staging by the `verify-restore` job, which also uploads the sanitized audit report (section 7.8) as an artifact.
- Full restore drills are performed **quarterly** in the staging environment.
- Drill results (time to restore, issues encountered) are recorded in the incident log.
- Any gaps identified during drills must be addressed before the next drill.

## 9. Escalation and On-Call Contacts

| Role | Contact | Escalation Path |
| --- | --- | --- |
| Primary on-call engineer | PagerDuty: `platform-oncall` | First responder |
| Secondary on-call engineer | PagerDuty: `platform-oncall` (backup) | Escalate after 15 min |
| Database administrator | `#db-ops` Slack channel | Escalate for DB-specific issues |
| Engineering manager | `#eng-leads` Slack channel | Escalate for extended outages |
| Security team | `security@<org>.example` | Escalate for suspected data breach |

**Escalation timeline:**

1. Acknowledge the incident within **15 minutes**.
2. If unresolved after **30 minutes**, escalate to the secondary on-call engineer.
3. If still unresolved after **1 hour**, escalate to the engineering manager.
4. For suspected security incidents, notify the security team immediately.
