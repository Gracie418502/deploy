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

### Backup outcomes: upload vs. retention

`backup.sh` reports two independent outcomes so operators can tell whether a recoverable backup exists:

| Field | Meaning | Where it appears |
| --- | --- | --- |
| `upload_status` | `success` once the encrypted archive **and** its manifest are in object storage; `failed` otherwise | Final summary line, `backup-status.json` workflow artifact, `$GITHUB_STEP_SUMMARY` |
| `retention_status` | `success` when the configured retention/pruning step completed; `failed` when pruning errored | Same places as `upload_status` |

**A recoverable backup exists whenever `upload_status=success`, even if `retention_status=failed`.** A pruning failure means old backups may accumulate (and bucket lifecycle rules still apply); it does **not** mean the new backup is missing. The script exits non-zero when either status is `failed`, but the summary and status file always distinguish the two so a retention failure is never mistaken for a lost backup — or vice versa. When `retention_status=failed`, check bucket usage and re-run pruning (or rely on the bucket lifecycle policy in section 3); no re-upload is needed.
=======

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
| `BACKUP_REQUIRED_FREE_BYTES` | `1073741824` (1 GiB) | Minimum free space required in the staging work directory before a database dump starts |

### Concurrent runs and run identifiers

Each invocation of `backup.sh` takes an exclusive execution lock on its staging work directory and derives a unique run identifier (`soroban-backup-<UTC timestamp>-<run id>`) that is used for the archive, manifest and metrics staging files. Two concurrent invocations therefore cannot overwrite each other's artifacts.

Collision behavior:

- If another run already holds the lock, the new invocation fails fast with a clear error and a non-zero exit code instead of waiting or sharing the work directory. Re-run it after the in-flight backup finishes.
- If a unique run identifier would collide with an existing artifact (for example, a stale lock left by a killed run), the run fails rather than overwriting the existing object. Remove the stale lock/artifacts after confirming no backup is running, then re-run.
- Scheduled runs are serialized by the workflow's concurrency group, so the lock is a second line of defense for manual or overlapping invocations.

### Staging free-space preflight

Before creating the database dump, `backup.sh` checks that the staging work directory has at least `BACKUP_REQUIRED_FREE_BYTES` free. If free space is below the budget, the run fails immediately — before any dump is taken — with a clear error and emits the failure metric `backup_preflight_free_space_failed` (with the required and available byte counts) so alerting can distinguish space exhaustion from other failures. Size the budget to comfortably exceed the uncompressed dump plus its compressed and encrypted copies.

### Artifact names and storage prefixes

Artifact names and storage prefixes are validated before any local or remote path is constructed. Accepted values:

- Must be non-empty and must not contain `/` or `\` (no path separators).
- Must not contain `..` (no parent traversal).
- Must not contain control characters (including newlines, tabs and NUL).
- Must not be `.` or start with `-`.

Names that fail validation are rejected with a clear error before any download, upload or local file is created. This applies to `--backup` values passed to `restore.sh` and to any configured storage prefix, so a crafted name cannot escape the `backups/` prefix in the bucket or the staging directory.

Optional archive validation budgets for `restore.sh` (checked before any extraction):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RESTORE_MAX_ARCHIVE_MEMBERS` | `10000` | Maximum number of members allowed in the decrypted tarball |
| `RESTORE_MAX_UNCOMPRESSED_BYTES` | `10737418240` (10 GiB) | Maximum total uncompressed size of all archive members |

### Archive validation hardening

Before extracting anything, `restore.sh` inspects the decrypted tarball and rejects it (exit code 2) when:

- **Member budget exceeded** — the archive contains more members than `RESTORE_MAX_ARCHIVE_MEMBERS`.
- **Size budget exceeded** — the summed uncompressed size of all members exceeds `RESTORE_MAX_UNCOMPRESSED_BYTES`. This guards against decompression bombs that would exhaust disk during extraction.
- **Duplicate member paths** — two members normalize to the same path (for example `./database.sql.gz`, `database.sql.gz` and `a/../database.sql.gz`). Duplicates are rejected because a later member could silently overwrite a previously extracted file.

Raise the budgets only for legitimately larger backups (e.g. `RESTORE_MAX_UNCOMPRESSED_BYTES=$((20*1024*1024*1024)) ./scripts/restore.sh ...`); a rejected archive usually indicates corruption or tampering and should be investigated rather than bypassed.

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

### Archive component allowlist

`restore.sh` validates the archive's top-level contents against an allowlist before restoring anything. The archive must contain exactly these **required** top-level components:

| Component | Kind | Purpose |
| --- | --- | --- |
| `database.sql.gz` | required file | Gzipped `pg_dump` output replayed into the target |
| `tables.txt` | required file | Table list used for verification |
| `contracts/` | required directory | Soroban contract state snapshots (may be empty when no contracts are configured) |
| `manifest.json` | required file | Manifest copy embedded in the archive (must match the downloaded manifest) |

The following **optional metadata** files are also allowed at the top level:

| Component | Kind | Purpose |
| --- | --- | --- |
| `backup-info.txt` | optional file | Human-readable summary written by `backup.sh` (timestamp, versions, component list) |
| `checksums.sha256` | optional file | Plain-text checksum listing for manual inspection |

Any other top-level entry — an unknown file, an unexpected directory, or any member with the executable bit set — is treated as unexplained content. `restore.sh` fails closed: it aborts with a non-zero exit code (2) and a clear error listing the offending entries **before** decrypting or touching the target database. If a required component is missing, restore also aborts. To restore an archive that legitimately needs additional components, update the allowlist in `restore.sh` and this document in the same change; do not bypass the check.

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

### 4.1 Multiple age recipients (multiple custodians)

To let more than one authorized custodian recover a backup, encrypt to a **recipients file** instead of a single recipient:

1. Each custodian generates their own age key pair locally and shares **only** the public recipient (`age1...`) with the backup operator. Private identities never leave the custodian's machine or secrets manager.
2. The operator maintains a recipients file (one `age1...` recipient per line, comments allowed), stored in the secrets manager and injected at runtime, e.g.:
   ```bash
   export BACKUP_ENCRYPTION_METHOD=age
   export BACKUP_AGE_RECIPIENTS_FILE=/run/secrets/backup-age-recipients.txt
   ./scripts/backup.sh
   ```
   `BACKUP_ENCRYPTION_KEY` may also point at a recipients file path. The file is read at encryption time and is **not** copied into the archive or manifest — artifacts contain no identities, only the ciphertext.
3. Any single listed recipient can decrypt the same archive:
   ```bash
   BACKUP_AGE_IDENTITY_FILE=~/custodian-a.key ./scripts/restore.sh --plan --backup soroban-backup-<timestamp>
   ```
4. **Verify each identity independently** (do this when adding or rotating a custodian, and in the quarterly drill): for each custodian, decrypt the same archive with that custodian's identity and confirm the component checksums match the manifest:
   ```bash
   for id in ~/custodian-a.key ~/custodian-b.key; do
     BACKUP_AGE_IDENTITY_FILE="$id" ./scripts/restore.sh --verify-only \
       --backup soroban-backup-<timestamp> --database-url "$STAGING_DATABASE_URL"
   done
   ```
   Each run must reach `restore complete`; a failure means that custodian cannot recover and their recipient must be re-added and a new backup taken.
5. Removing a custodian only affects **future** backups: drop their recipient from the file and take a new backup. Existing archives remain decryptable by them until they age out of retention.
=======

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
- A target database role with the permissions the restore needs: `CREATE` on the target schema, `INSERT`/`TRUNCATE` on the tables being restored, and `CREATEDB` when running with `--verify-only` (which creates a throwaway database).

`scripts/restore.sh` reads the same `BACKUP_STORAGE_*` and `BACKUP_ENCRYPTION_KEY` variables as `backup.sh` (for age-encrypted backups, set `BACKUP_AGE_IDENTITY_FILE` instead).

### 7.1.1 Preflight checks

Before any expensive work — downloading the archive, verifying its SHA-256, or decrypting it — `restore.sh` runs a preflight against the target database:

- It checks that the target is reachable and that the role can connect.
- It checks the required permissions: `CREATE` on the target schema, `INSERT`/`TRUNCATE` on the target tables, and `CREATEDB` when `--verify-only` is used.
- It checks the target server version against the manifest's `postgres` metadata.

If the target is unreachable or the role lacks a required permission, the script aborts immediately with a clear error and a non-zero exit code, **before** the archive is downloaded or decrypted. Because decryption never starts, no decrypted staging artifacts are left behind. The work directory is removed by a cleanup trap on every exit path (success, failure, or interrupt); pass `--keep-work-dir` only when you intentionally want to inspect extracted files, and remember that this also keeps any decrypted content for that run.

### 7.2 Steps

1. **Identify the backup to restore.**
   ```bash
   aws s3 ls s3://<backup-bucket>/backups/ | grep manifest | tail -n 5
   ```
   Pick the newest backup that precedes the incident. If you omit `--backup`, `restore.sh` uses the newest one.

2. **Plan the restore (no database writes).**
   ```bash
   ./scripts/restore.sh --plan --backup soroban-backup-<timestamp> \
     --database-url "$DATABASE_URL"
   ```
   `--plan` downloads the manifest and archive, validates the manifest schema and required fields, verifies the archive SHA-256 and component checksums, and reports the archive's components, the recorded `postgres` versions (`serverVersion`, `pgDumpVersion`), the target server version and the intended target database — then stops. It runs no mutating SQL and does not create, drop or modify anything in the target. Use it to confirm compatibility (section 0) and that the right backup and target were chosen before any restore. It exits non-zero if validation fails.

3. **Rehearse against a scratch database (recommended).**
   ```bash
   ./scripts/restore.sh --backup soroban-backup-<timestamp> --verify-only \
     --database-url postgresql://<user>:<pass>@<staging-host>:5432/postgres
   ```

4. **Restore into the target database.**
   ```bash
   ./scripts/restore.sh --backup soroban-backup-<timestamp> --database-url "$DATABASE_URL"
   ```
   The script downloads the manifest and archive, validates the manifest schema version and required fields, verifies the archive SHA-256, decrypts, then checks the archive's top-level contents against the component allowlist (see section 2, "Archive component allowlist"): all required components (`database.sql.gz`, `tables.txt`, `contracts/`, `manifest.json`) must be present, only the documented optional metadata files may accompany them, and any other entry or executable member aborts the restore before anything is applied. It then verifies each component checksum from `components` against the decrypted files before replaying the dump in a single transaction (a failed restore changes nothing). Objects in the target that are not in the backup are left in place. If the manifest's `postgres` versions are incompatible with the target server, the script warns (or aborts with `--verify-only`) before applying anything.
   The script first runs the preflight checks described in section 7.1.1 (target connectivity, required permissions, and PostgreSQL version compatibility) and aborts early with a clear error if they fail — before downloading or decrypting anything, so no decrypted staging artifacts are created. Once preflight passes, it downloads the manifest and archive, validates the manifest schema version and required fields, verifies the archive SHA-256, decrypts, then verifies each component checksum from `components` against the decrypted files before replaying the dump in a single transaction (a failed restore changes nothing). Objects in the target that are not in the backup are left in place. If the manifest's `postgres` versions are incompatible with the target server, the script warns (or aborts with `--verify-only`) before applying anything. The work directory is cleaned up by a trap on every exit path unless `--keep-work-dir` is given.
   The script downloads the manifest and archive, validates the manifest schema version and required fields, verifies the archive SHA-256, decrypts, then validates the decrypted tarball before extraction: member count and total uncompressed size must stay within the configured budgets, and no two members may normalize to the same path (see section 2). Only after these checks pass does it extract, verify each component checksum from `components` against the decrypted files, and replay the dump in a single transaction (a failed restore changes nothing). Objects in the target that are not in the backup are left in place. If the manifest's `postgres` versions are incompatible with the target server, the script warns (or aborts with `--verify-only`) before applying anything.

   Before any destructive SQL is applied, `restore.sh` runs two pre-flight checks against the target (see sections 7.5 and 7.6): a PostgreSQL **extension inventory** comparison and a **lock/statement timeout** policy. Both produce actionable diagnostics and abort the restore before the transaction starts when they fail.

5. **Inspect contract state snapshots (if needed).** Add `--keep-work-dir` to keep the extracted `contracts/` snapshots. On-chain state cannot be "restored"; use the snapshots to confirm which contract IDs the application should point at, and use `scripts/rollback-contracts.cjs` to repoint it.

6. **Re-provision secrets.** Retrieve the required secrets from the secrets manager and inject them into the restored environment. Do **not** restore secrets from backups.

7. **Run migrations (if the backup predates the current release).** The Kubernetes `migrate` initContainer does this on the next rollout, or run it manually:
   ```bash
   kubectl -n synapsvault rollout restart deployment/backend
   ```

8. **Restart application services** against the restored database.

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

If the restore fails, `restore.sh` rolls its transaction back and exits non-zero (2 = download/manifest validation/checksum/archive allowlist, 3 = decryption or component checksum mismatch, 4 = restore, 5 = verification). Fix the cause and re-run, or re-attempt with an earlier backup. If the failure is an unsupported manifest `schemaVersion`, use a `restore.sh` from the matching or newer release. If the failure is an archive allowlist violation (unexpected top-level entry, executable member, or missing required component), do not restore that archive: treat it as suspect, preserve it for investigation, and restore an earlier verified backup. Document the failure and notify the on-call engineer.
If the restore fails, `restore.sh` rolls its transaction back and exits non-zero (2 = download/manifest validation/checksum, 3 = decryption or component checksum mismatch, 4 = restore, 5 = verification). Fix the cause and re-run, or re-attempt with an earlier backup. If the failure is an unsupported manifest `schemaVersion`, use a `restore.sh` from the matching or newer release. If preflight fails (unreachable target or missing permissions), fix connectivity or grant the required permissions and re-run; nothing was downloaded or decrypted, so there is no staging state to clean up. Document the failure and notify the on-call engineer.
If the restore fails, `restore.sh` rolls its transaction back and exits non-zero (2 = download/manifest validation/checksum or archive validation failure such as an exceeded member/size budget or duplicate member paths, 3 = decryption or component checksum mismatch, 4 = restore, 5 = verification). Fix the cause and re-run, or re-attempt with an earlier backup. If the failure is an unsupported manifest `schemaVersion`, use a `restore.sh` from the matching or newer release. Document the failure and notify the on-call engineer.

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
- `backup.sh --dry-run` prints the planned components (database dump, contract snapshots), the destination bucket/prefix and the retention actions that would run, then exits. It performs **no** dump, upload or delete, and never prints credentials, keys or connection strings (they are redacted). Use it to validate configuration changes safely.
- `restore.sh --plan` is exercised in the verification workflow to confirm a backup's metadata and archive safety without touching a database.
- The verification workflow also covers a successful upload followed by a failed retention cleanup, asserting `upload_status=success` and `retention_status=failed` are reported separately.
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
