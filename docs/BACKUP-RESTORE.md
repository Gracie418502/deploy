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

## 2.1 Object-Storage Credential Scopes (Least Privilege)

The backup and restore tooling needs three distinct kinds of access to the backup bucket. Grant each one to a **separate** credential so that a leaked upload key cannot delete backups, and a restore key cannot overwrite them.

| Scope | Used by | Operations needed | Typical lifetime |
| --- | --- | --- | --- |
| **Upload** | `scripts/backup.sh` (daily job) | Write new objects; abort interrupted multipart uploads | Long-lived CI secret |
| **Pruning** | Bucket lifecycle / retention job | List objects and delete expired ones | Long-lived, tightly held |
| **Restore** | `scripts/restore.sh` (on-call, verify job) | Read/list objects only | Short-lived, issued per incident |

The scripts themselves never delete backups (see section 3); pruning is done by the bucket lifecycle policy or a dedicated job. All examples below use placeholders — never commit real keys, account IDs or bucket names.

### 2.1.1 AWS S3

Upload policy (attach to the backup role/user):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupUpload",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::${BACKUP_STORAGE_BUCKET}/backups/*"
    }
  ]
}
```

Pruning policy (lifecycle job only):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupPrune",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::${BACKUP_STORAGE_BUCKET}"
    },
    {
      "Sid": "BackupPruneDelete",
      "Effect": "Allow",
      "Action": "s3:DeleteObject",
      "Resource": "arn:aws:s3:::${BACKUP_STORAGE_BUCKET}/backups/*"
    }
  ]
}
```

Restore policy (on-call / verify job):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupRestore",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::${BACKUP_STORAGE_BUCKET}",
        "arn:aws:s3:::${BACKUP_STORAGE_BUCKET}/backups/*"
      ]
    }
  ]
}
```

Verify the effective permissions without printing credentials:

```bash
# Bucket policy (shows what is granted, not who holds the keys)
aws s3api get-bucket-policy --bucket "$BACKUP_STORAGE_BUCKET" --query Policy --output text

# Confirm the current identity and that it is the expected role
aws sts get-caller-identity

# Dry-run each scope; expect AccessDenied for the scopes this key must not have
aws s3api head-bucket --bucket "$BACKUP_STORAGE_BUCKET"
aws s3api list-objects-v2 --bucket "$BACKUP_STORAGE_BUCKET" --prefix backups/ --max-items 1
```

### 2.1.2 Google Cloud Storage

Upload role (custom role or `roles/storage.objectCreator` scoped to the bucket):

```yaml
# gcs-upload-role.yaml — bind to the backup service account on the bucket only
title: BackupUpload
description: Write backup objects and abort interrupted uploads
stage: GA
includedPermissions:
  - storage.objects.create
  - storage.multipartUploads.abort
```

Pruning role:

```yaml
# gcs-prune-role.yaml — bind to the retention job service account
title: BackupPrune
description: List and delete expired backup objects
stage: GA
includedPermissions:
  - storage.objects.list
  - storage.objects.delete
  - storage.multipartUploads.list
```

Restore role (`roles/storage.objectViewer` on the bucket is sufficient):

```yaml
# gcs-restore-role.yaml — bind to the on-call / verify service account
title: BackupRestore
description: Read backup objects and list the bucket
stage: GA
includedPermissions:
  - storage.objects.get
  - storage.objects.list
```

Verify the bucket IAM policy (no credentials are printed):

```bash
gcloud storage buckets get-iam-policy "gs://${BACKUP_STORAGE_BUCKET}" \
  --format='table(bindings.role,bindings.members)'

# Confirm which identity the current session uses
gcloud auth list --filter=status:ACTIVE --format='value(account)'
```

### 2.1.3 Azure Blob Storage

Assign built-in roles at the **container** scope where possible:

| Scope | Built-in role | Notes |
| --- | --- | --- |
| Upload | `Storage Blob Data Contributor` on the container | Needed for `Put Blob`/`Put Block` and aborting uncommitted blocks |
| Pruning | `Storage Blob Data Contributor` on the container, held only by the retention job | Adds list + delete |
| Restore | `Storage Blob Data Reader` on the container | Read/list only |

If a custom role is required, the minimum data actions are:

```json
{
  "Name": "BackupUpload",
  "Actions": [],
  "DataActions": [
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"
  ],
  "AssignableScopes": ["/subscriptions/<subscription-id>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>"]
}
```

```json
{
  "Name": "BackupPrune",
  "Actions": [],
  "DataActions": [
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/list/action"
  ],
  "AssignableScopes": ["/subscriptions/<subscription-id>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>"]
}
```

```json
{
  "Name": "BackupRestore",
  "Actions": [],
  "DataActions": [
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/list/action"
  ],
  "AssignableScopes": ["/subscriptions/<subscription-id>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>"]
}
```

Verify container permissions and role assignments:

```bash
# Container-level permissions for the current identity
az storage container show-permissions \
  --name "$BACKUP_STORAGE_CONTAINER" \
  --account-name "$BACKUP_STORAGE_ACCOUNT" \
  --auth-mode login

# Role assignments scoped to the container (shows principals, not secrets)
az role assignment list \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/$BACKUP_STORAGE_ACCOUNT/blobServices/default/containers/$BACKUP_STORAGE_CONTAINER" \
  --query '[].{role:roleDefinitionName,principal:principalName}' \
  --output table
```

### 2.1.4 Verification checklist

- [ ] Upload, pruning and restore each use a distinct credential/role.
- [ ] The upload credential cannot list or delete objects (expect `AccessDenied`).
- [ ] The restore credential cannot write or delete objects (expect `AccessDenied`).
- [ ] The pruning credential is not available to the backup or restore jobs.
- [ ] Verification commands read bucket/account names from environment variables; no keys, tokens or account IDs are committed.
- [ ] The `BACKUP_STORAGE_*` variables used above are documented in [`docs/ENVIRONMENT-VARIABLES.md`](./ENVIRONMENT-VARIABLES.md).

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
- [ ] The application's `/health` endpoint reports healthy.
- [ ] Smoke tests pass (`BACKEND_URL=... npm run test:smoke`).
- [ ] No errors in application logs for 15 minutes post-restore.
- [ ] RTO/RPO targets were met (record actual times).

### 7.4 Rollback

If the restore fails, `restore.sh` rolls its transaction back and exits non-zero (2 = download/manifest validation/checksum, 3 = decryption or component checksum mismatch, 4 = restore, 5 = verification). Fix the cause and re-run, or re-attempt with an earlier backup. If the failure is an unsupported manifest `schemaVersion`, use a `restore.sh` from the matching or newer release. Document the failure and notify the on-call engineer.

## 8. Testing

- Restores are verified automatically **weekly** against staging by the `verify-restore` job.
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
