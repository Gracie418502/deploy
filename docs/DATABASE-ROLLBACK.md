# Database Migration Rollback Runbook

This runbook describes how to safely roll back database migrations for this project.

## Overview

- **Migration tool:** [`drizzle-kit`](https://orm.drizzle.team/docs/kit-overview) (paired with `drizzle-orm`).
- **Migration files:** stored in `drizzle/` (SQL files) with metadata in `drizzle/meta/`.
- **Database:** Supabase (PostgreSQL).
- **Applied migrations tracking:** Drizzle records applied migrations in the `__drizzle_migrations` table in the `drizzle` schema.

> ⚠️ Drizzle does not generate "down" migrations automatically. Rollbacks are performed either by applying a hand-written reverse SQL migration or by restoring from a Supabase backup. Choose the approach that matches the change.

---

## 1. List Applied Migrations

Inspect the migrations Drizzle has recorded as applied:

```bash
# Using psql against the Supabase connection string
psql "$DATABASE_URL" -c "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at;"
```

You can also list the migration files present locally:

```bash
ls -1 drizzle/*.sql
```

Compare the two lists to determine which migrations are applied vs. pending.

---

## 2. Roll Back the Last Migration

Drizzle has no built-in `down` command, so roll back by applying a reverse migration.

**Scripted (recommended):** write the reverse SQL (step 2 below), then let
[`scripts/db-rollback.sh`](../scripts/db-rollback.sh) apply it *and* remove the
latest row from `drizzle.__drizzle_migrations` in a single transaction:

```bash
# Rehearse: runs everything, then rolls the transaction back
DATABASE_URL=... ./scripts/db-rollback.sh --file drizzle/9999_rollback_last.sql --dry-run

# Apply (prompts for confirmation when --env production, unless --yes)
DATABASE_URL=... ./scripts/db-rollback.sh --file drizzle/9999_rollback_last.sql --env production
```

If the reverse SQL fails, nothing is committed. The manual equivalent is:

1. **Identify the last applied migration:**

   ```bash
   psql "$DATABASE_URL" -c "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1;"
   ```

2. **Write a reverse SQL migration** that undoes the change (e.g. `DROP TABLE`, `DROP COLUMN`, restore prior constraint). Save it as a new file, e.g. `drizzle/9999_rollback_last.sql`.

3. **Apply the reverse migration:**

   ```bash
   psql "$DATABASE_URL" -f drizzle/9999_rollback_last.sql
   ```

4. **Remove the corresponding row** from the migrations table so Drizzle no longer considers the original migration applied:

   ```bash
   psql "$DATABASE_URL" -c "DELETE FROM drizzle.__drizzle_migrations WHERE id = '<migration_id>';"
   ```

5. **Verify** with the checklist in section 6.

> Prefer creating a new forward migration that reverses the change rather than deleting history, when possible. Deleting rows from `__drizzle_migrations` is only appropriate when you are certain no other environment depends on that migration record.

---

## 3. Roll Back to a Specific Migration

To roll back more than one migration in a single run, pass `--steps` with a
reverse SQL file that undoes each of those migrations, newest first.
[`scripts/db-rollback.sh`](../scripts/db-rollback.sh) applies that file and
deletes the same number of newest rows from `drizzle.__drizzle_migrations`
in one transaction:

```bash
# Rehearse reverting the three newest migrations
DATABASE_URL=... ./scripts/db-rollback.sh \
  --file drizzle/rollback_to_<target>.sql \
  --steps 3 \
  --dry-run

# Apply (prompts for confirmation when --env production, unless --yes)
DATABASE_URL=... ./scripts/db-rollback.sh \
  --file drizzle/rollback_to_<target>.sql \
  --steps 3 \
  --env production
```

`--steps` defaults to `1`. The script refuses to continue when fewer than
`<n>` migrations are recorded.

The manual equivalent is:

1. **List applied migrations in reverse chronological order:**

   ```bash
   psql "$DATABASE_URL" -c "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC;"
   ```

2. **Determine the target migration** you want to keep. Everything applied *after* it must be reversed.

3. **Write reverse SQL** for each migration to be undone, in reverse order (newest first). Combine them into a single script, e.g. `drizzle/rollback_to_<target>.sql`.

4. **Apply the reverse script:**

   ```bash
   psql "$DATABASE_URL" -f drizzle/rollback_to_<target>.sql
   ```

5. **Delete the corresponding rows** from the migrations table:

   ```bash
   psql "$DATABASE_URL" -c "DELETE FROM drizzle.__drizzle_migrations WHERE id IN ('<id1>', '<id2>', ...);"
   ```

6. **Verify** with the checklist in section 6.

---

## 4. Restore from a Supabase Point-in-Time Backup

Use this when a rollback cannot be expressed as reverse SQL, or when data corruption occurred.

1. **Open the Supabase Dashboard** → your project → **Database** → **Backups**.

2. **Choose a point in time** prior to the problematic migration. Supabase retains PITR backups based on your plan's retention window.

3. **Initiate the restore.** Supabase will provision a restored instance. Note the connection details of the restored database.

4. **Validate the restored data** before switching traffic:
   - Confirm the target migration state in `drizzle.__drizzle_migrations`.
   - Spot-check critical tables and row counts.

5. **Repoint the application** to the restored database by updating `DATABASE_URL` (and any Supabase keys if the project reference changed).

6. **Re-apply any migrations** that were intentionally made after the restore point, using `drizzle-kit`:

   ```bash
   npx drizzle-kit migrate
   ```

7. **Verify** with the checklist in section 6.

> ⚠️ PITR restores are destructive to the current database state. Always take a manual snapshot or confirm the restore target before proceeding.

---

## 5. Expand-and-Contract Releases

Rolling deployments run old and new backend versions side by side for a
window of time. During that window every schema change must be compatible
with **both** versions, otherwise old replicas will break as soon as the
migration lands. Use the expand-and-contract pattern to sequence schema
changes across releases.

### 5.1 The three phases

1. **Expand** — add the new structure without removing anything:
   - New columns must be **nullable** or have a `DEFAULT` so inserts from old
     code (which does not know about the column) still succeed.
   - New tables and indexes are additive; old code simply ignores them.
   - Do not rename or drop existing columns, tighten `NOT NULL`, or add
     constraints that old code can violate.
2. **Migrate** — backfill and dual-write while both versions run:
   - Backfill existing rows in **batches** (e.g. a few thousand rows per
     statement) to avoid long locks and replication lag.
   - New code writes to both the old and new columns (dual-write) and reads
     from the new one, falling back to the old one when it is empty.
   - Old code keeps writing only the old column; the backfill and dual-write
     keep the new column consistent.
3. **Contract** — remove the old structure **only after every replica runs
   the new version**:
   - Drop the old column, old constraint, or old index in a *separate,
     later* release.
   - Before contracting, confirm no running code reads or writes the old
     structure (search the codebase, check feature flags, confirm the rollout
     is complete).

### 5.2 Compatibility rules for rolling deployments

- **No destructive DDL in the same release as the code that stops using it.**
  Dropping a column in the release that removes its last reader means old
  replicas still running the previous version will fail mid-rollout.
- **Additive-only migrations during rollout.** A migration that ships with a
  code release should only add columns, tables, indexes, or nullable
  constraints. Destructive or tightening changes go in a follow-up release.
- **Backfill in batches.** Never backfill a large table in a single
  `UPDATE`; chunk by primary key and commit between batches.
- **Keep the previous release deployable.** Until the contract phase has run,
  rolling the code back to the previous version must still work against the
  current schema.

### 5.3 Worked example

Goal: replace `users.full_name` with separate `first_name` / `last_name`
columns without downtime.

**Release N — expand + migrate (additive only)**

```sql
-- drizzle/0100_add_name_columns.sql
ALTER TABLE users ADD COLUMN first_name text;
ALTER TABLE users ADD COLUMN last_name  text;
```

Backfill in batches (run once, outside the migration, or as a scripted job):

```sql
-- Repeat until no rows are returned.
UPDATE users
SET first_name = split_part(full_name, ' ', 1),
    last_name  = NULLIF(substr(full_name, strpos(full_name, ' ') + 1), full_name)
WHERE id IN (
  SELECT id FROM users WHERE first_name IS NULL ORDER BY id LIMIT 1000
);
```

Application code in release N dual-writes `full_name`, `first_name`, and
`last_name`, and reads `first_name`/`last_name` with a fallback to
`full_name` when they are null.

**Rollout sequence**

1. Apply migration `0100` (additive; old and new code both tolerate it).
2. Deploy release N. Old and new replicas run side by side; both write
   `full_name`, new replicas also write the split columns.
3. Run the batched backfill until it reports zero remaining rows.
4. Verify: `SELECT count(*) FROM users WHERE first_name IS NULL;` returns `0`
   (or only rows created by old replicas, which the dual-write covers).
5. Wait for the rollout to complete — every replica now runs release N.

**Rollback boundary**

The rollback boundary is the point *after* the contract phase (release N+1)
has been applied. Up to and including step 5 above, rolling the code back to
release N-1 is safe: the schema is still additive and `full_name` is intact.
Once the destructive migration in release N+1 drops `full_name`, reverting the
code to any version that still reads `full_name` will fail — from that point
forward the only safe recovery is a forward fix or a PITR restore (section 4).

**Release N+1 — contract (delayed destructive migration)**

Ship this only after release N has been fully rolled out and stable for at
least one release cycle:

```sql
-- drizzle/0101_drop_full_name.sql
ALTER TABLE users DROP COLUMN full_name;
```

Verification steps before dropping the old column:

- [ ] Confirm every replica runs release N or later (deployment history /
      rollout status shows no old pods).
- [ ] Search the codebase for remaining reads/writes of `full_name`; none
      should exist outside the migration itself.
- [ ] Confirm the backfill completed: `SELECT count(*) FROM users WHERE first_name IS NULL;` returns `0`.
- [ ] Confirm no feature flag or fallback path still selects `full_name`.
- [ ] Take a fresh backup / snapshot before applying the drop.
- [ ] Apply `0101` via `npx drizzle-kit migrate` and run the post-rollback
      smoke tests from section 6.

---

## 6. Pre/Post-Rollback Verification Checklist

### Pre-Rollback

- [ ] Confirmed the migration(s) to be rolled back and their IDs.
- [ ] Captured a fresh backup / snapshot of the current database.
- [ ] Notified stakeholders and confirmed a maintenance window if needed.
- [ ] Application traffic paused or put into read-only mode (if applicable).
- [ ] Reverse SQL script reviewed by a second engineer.
- [ ] Verified `DATABASE_URL` points to the intended environment (not production by accident).

### Post-Rollback

- [ ] Reverse SQL applied without errors.
- [ ] `drizzle.__drizzle_migrations` reflects the expected state:
      `psql "$DATABASE_URL" -c "SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at;"`
- [ ] Schema matches expectations (tables, columns, constraints, indexes).
- [ ] Application starts successfully and connects to the database.
- [ ] Smoke tests pass (auth, core read/write paths).
- [ ] No orphaned or missing foreign key references.
- [ ] Logs show no migration- or schema-related errors.
- [ ] Stakeholders notified that rollback is complete.

---

## Notes

- Always run migrations and rollbacks against a staging environment first.
- Sequence schema changes with expand-and-contract (section 5) so old and new
  backend versions stay compatible during rolling deployments.
- Keep reverse SQL scripts in version control alongside the forward migrations.
- If unsure, prefer restoring from a Supabase backup over ad-hoc SQL edits.