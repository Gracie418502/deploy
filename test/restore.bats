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

@test "write_restore_audit_report emits required fields and redacts passwords" {
  local report="$BATS_TEST_TMPDIR/audit.json"
  local target="postgres://restore_user:s3cr3tpass@db.internal:5432/soroban?sslmode=require"
  run write_restore_audit_report "$report" \
    "backups/soroban-backup-20260101T020000Z.tar.gz.enc" \
    "$target" \
    "2026-01-01T02:00:00Z" \
    "2026-01-01T02:10:00Z" \
    "database.sql=ok,contracts.tar.gz=ok" \
    "checksums=ok,rowcounts=ok"
  [ "$status" -eq 0 ]
  [ -f "$report" ]

  run cat "$report"
  [ "$status" -eq 0 ]
  [[ "$output" == *"backups/soroban-backup-20260101T020000Z.tar.gz.enc"* ]]
  [[ "$output" == *"db.internal:5432/soroban"* ]]
  [[ "$output" == *"2026-01-01T02:00:00Z"* ]]
  [[ "$output" == *"2026-01-01T02:10:00Z"* ]]
  [[ "$output" == *"database.sql=ok"* ]]
  [[ "$output" == *"rowcounts=ok"* ]]
  [[ "$output" != *"s3cr3tpass"* ]]
}

@test "redact_database_url strips the password from a connection URL" {
  run redact_database_url "postgres://user:hunter2@localhost:5432/app?sslmode=disable"
  [ "$status" -eq 0 ]
  [ "$output" = "postgres://user@localhost:5432/app?sslmode=disable" ]
}

@test "verify_critical_row_counts fails when a critical table is truncated" {
  local counts="$BATS_TEST_TMPDIR/counts.txt"
  cat >"$counts" <<'EOF'
accounts 100 100
ledgers 50 10
EOF
  run verify_critical_row_counts "$counts"
  [ "$status" -ne 0 ]
  [[ "$output" == *"ledgers"* ]]
}

@test "verify_critical_row_counts passes when counts are within bounds" {
  local counts="$BATS_TEST_TMPDIR/counts-ok.txt"
  cat >"$counts" <<'EOF'
accounts 100 100
ledgers 50 50
EOF
  run verify_critical_row_counts "$counts"
  [ "$status" -eq 0 ]
}

@test "verify_critical_row_counts fails when a critical table is missing" {
  local counts="$BATS_TEST_TMPDIR/counts-missing.txt"
  cat >"$counts" <<'EOF'
accounts 100 0
EOF
  run verify_critical_row_counts "$counts"
  [ "$status" -ne 0 ]
  [[ "$output" == *"accounts"* ]]
}

@test "check_required_extensions reports missing extensions with diagnostics" {
  local required="$BATS_TEST_TMPDIR/required-ext.txt"
  printf 'pgcrypto\npg_stat_statements\n' >"$required"
  local available="$BATS_TEST_TMPDIR/available-ext.txt"
  printf 'pgcrypto\n' >"$available"
  run check_required_extensions "$required" "$available"
  [ "$status" -ne 0 ]
  [[ "$output" == *"pg_stat_statements"* ]]
  [[ "$output" == *"missing"* || "$output" == *"not available"* ]]
}

@test "check_required_extensions passes when all extensions are available" {
  local required="$BATS_TEST_TMPDIR/required-ext-ok.txt"
  printf 'pgcrypto\n' >"$required"
  local available="$BATS_TEST_TMPDIR/available-ext-ok.txt"
  printf 'pgcrypto\npg_stat_statements\n' >"$available"
  run check_required_extensions "$required" "$available"
  [ "$status" -eq 0 ]
}

@test "restore timeout defaults are bounded and configurable" {
  run restore_timeout_settings
  [ "$status" -eq 0 ]
  [[ "$output" == *"lock_timeout"* ]]
  [[ "$output" == *"statement_timeout"* ]]

  RESTORE_LOCK_TIMEOUT="5s" RESTORE_STATEMENT_TIMEOUT="30s" run restore_timeout_settings
  [ "$status" -eq 0 ]
  [[ "$output" == *"5s"* ]]
  [[ "$output" == *"30s"* ]]
}

@test "restore.sh --help exits 0" {
  run "$REPO_ROOT/scripts/restore.sh" --help
  [ "$status" -eq 0 ]
}

@test "restore.sh rejects an unknown flag" {
  run "$REPO_ROOT/scripts/restore.sh" --not-a-flag
  [ "$status" -eq 1 ]
}
