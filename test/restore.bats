#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/restore.sh"
}

@test "with_database rewrites the database name and keeps the query string" {
  run with_database "postgres://user:pass@localhost:5432/olddb?sslmode=require" "restore_verify"
  [ "$status" -eq 0 ]
  [ "$output" = "postgres://user:pass@localhost:5432/restore_verify?sslmode=require" ]
}

@test "with_database accepts a postgresql scheme" {
  run with_database "postgresql://localhost/app" "other"
  [ "$status" -eq 0 ]
  [ "$output" = "postgresql://localhost/other" ]
}

@test "with_database rejects a non-postgres URL" {
  run with_database "http://localhost/olddb" "other"
  [ "$status" -eq 1 ]
}

@test "manifest_field reads key, value, and method" {
  local manifest="$BATS_TEST_TMPDIR/sample.manifest.json"
  cat >"$manifest" <<'EOF'
{
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg"
}
EOF
  run manifest_field key "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "backups/soroban-backup-20260101T020000Z.tar.gz.enc" ]

  run manifest_field value "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]

  run manifest_field method "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "gpg" ]
}

@test "manifest_field reads schema version and component checksums" {
  local manifest="$BATS_TEST_TMPDIR/versioned.manifest.json"
  cat >"$manifest" <<'EOF'
{
  "schemaVersion": 1,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {
    "database.sql": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "contracts.tar.gz": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }
}
EOF
  run manifest_field schemaVersion "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]

  run manifest_field postgresServerVersion "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "16.2" ]

  run manifest_field pgDumpVersion "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "16.2" ]

  run manifest_field componentChecksums.database.sql "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]

  run manifest_field componentChecksums.contracts.tar.gz "$manifest"
  [ "$status" -eq 0 ]
  [ "$output" = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" ]
}

@test "restore.sh rejects an unsupported manifest schema version before restoring" {
  local manifest="$BATS_TEST_TMPDIR/unsupported.manifest.json"
  cat >"$manifest" <<'EOF'
{
  "schemaVersion": 999,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {
    "database.sql": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
EOF
  run "$REPO_ROOT/scripts/restore.sh" --manifest "$manifest" --verify-only
  [ "$status" -ne 0 ]
  [[ "$output" == *"schema"* || "$output" == *"version"* ]]
}

@test "restore.sh fails when a component checksum does not match after decryption" {
  local workdir="$BATS_TEST_TMPDIR/restore-work"
  mkdir -p "$workdir"
  printf 'tampered database dump\n' >"$workdir/database.sql"
  local actual
  actual="$(sha256sum "$workdir/database.sql" | awk '{print $1}')"
  local expected="0000000000000000000000000000000000000000000000000000000000000000"
  [ "$actual" != "$expected" ]

  local manifest="$BATS_TEST_TMPDIR/mismatch.manifest.json"
  cat >"$manifest" <<EOF
{
  "schemaVersion": 1,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {
    "database.sql": "$expected"
  }
}
EOF
  run verify_component_checksums "$workdir" "$manifest"
  [ "$status" -ne 0 ]
}

@test "restore.sh accepts matching component checksums after decryption" {
  local workdir="$BATS_TEST_TMPDIR/restore-ok"
  mkdir -p "$workdir"
  printf 'valid database dump\n' >"$workdir/database.sql"
  local actual
  actual="$(sha256sum "$workdir/database.sql" | awk '{print $1}')"

  local manifest="$BATS_TEST_TMPDIR/match.manifest.json"
  cat >"$manifest" <<EOF
{
  "schemaVersion": 1,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {
    "database.sql": "$actual"
  }
}
EOF
  run verify_component_checksums "$workdir" "$manifest"
  [ "$status" -eq 0 ]
}

@test "restore.sh --plan reports components, versions and target without mutating the database" {
  local workdir="$BATS_TEST_TMPDIR/plan-work"
  mkdir -p "$workdir/archive"
  printf 'valid database dump\n' >"$workdir/archive/database.sql"
  printf 'contracts\n' >"$workdir/archive/contracts.tar.gz"
  local db_sum contracts_sum
  db_sum="$(sha256sum "$workdir/archive/database.sql" | awk '{print $1}')"
  contracts_sum="$(sha256sum "$workdir/archive/contracts.tar.gz" | awk '{print $1}')"

  local manifest="$BATS_TEST_TMPDIR/plan.manifest.json"
  cat >"$manifest" <<EOF
{
  "schemaVersion": 1,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {
    "database.sql": "$db_sum",
    "contracts.tar.gz": "$contracts_sum"
  }
}
EOF

  # Any psql invocation is a failure: --plan must never touch the database.
  local stub_dir="$BATS_TEST_TMPDIR/plan-bin"
  mkdir -p "$stub_dir"
  cat >"$stub_dir/psql" <<'EOF'
#!/usr/bin/env bash
echo "psql must not be invoked in plan mode" >&2
exit 99
EOF
  chmod +x "$stub_dir/psql"

  run env PATH="$stub_dir:$PATH" \
    DATABASE_URL="postgres://user:pass@localhost:5432/soroban" \
    RESTORE_PLAN_ARCHIVE_DIR="$workdir/archive" \
    "$REPO_ROOT/scripts/restore.sh" --manifest "$manifest" --plan
  [ "$status" -eq 0 ]
  [[ "$output" == *"database.sql"* ]]
  [[ "$output" == *"contracts.tar.gz"* ]]
  [[ "$output" == *"16.2"* ]]
  [[ "$output" == *"soroban"* ]]
  [[ "$output" != *"psql must not be invoked"* ]]
}

@test "restore.sh --plan rejects an unsupported manifest schema version" {
  local manifest="$BATS_TEST_TMPDIR/plan-unsupported.manifest.json"
  cat >"$manifest" <<'EOF'
{
  "schemaVersion": 999,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {
    "database.sql": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
EOF
  run "$REPO_ROOT/scripts/restore.sh" --manifest "$manifest" --plan
  [ "$status" -ne 0 ]
  [[ "$output" == *"schema"* || "$output" == *"version"* ]]
}

@test "restore.sh --plan fails when a component checksum does not match" {
  local workdir="$BATS_TEST_TMPDIR/plan-mismatch"
  mkdir -p "$workdir/archive"
  printf 'tampered database dump\n' >"$workdir/archive/database.sql"

  local manifest="$BATS_TEST_TMPDIR/plan-mismatch.manifest.json"
  cat >"$manifest" <<'EOF'
{
  "schemaVersion": 1,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {
    "database.sql": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
EOF
  run env RESTORE_PLAN_ARCHIVE_DIR="$workdir/archive" \
    "$REPO_ROOT/scripts/restore.sh" --manifest "$manifest" --plan
  [ "$status" -ne 0 ]
}

@test "restore.sh --plan rejects an unsafe archive entry" {
  local workdir="$BATS_TEST_TMPDIR/plan-unsafe"
  mkdir -p "$workdir/archive"
  printf 'malicious\n' >"$workdir/archive/../escape.txt"

  local manifest="$BATS_TEST_TMPDIR/plan-unsafe.manifest.json"
  cat >"$manifest" <<'EOF'
{
  "schemaVersion": 1,
  "key": "backups/soroban-backup-20260101T020000Z.tar.gz.enc",
  "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "method": "gpg",
  "postgresServerVersion": "16.2",
  "pgDumpVersion": "16.2",
  "componentChecksums": {}
}
EOF
  run env RESTORE_PLAN_ARCHIVE_DIR="$workdir/archive" \
    "$REPO_ROOT/scripts/restore.sh" --manifest "$manifest" --plan
  [ "$status" -ne 0 ]
}

@test "restore.sh --help exits 0" {
  run "$REPO_ROOT/scripts/restore.sh" --help
  [ "$status" -eq 0 ]
}

@test "restore.sh rejects an unknown flag" {
  run "$REPO_ROOT/scripts/restore.sh" --not-a-flag
  [ "$status" -eq 1 ]
}
