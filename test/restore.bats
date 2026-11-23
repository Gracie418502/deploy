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

@test "validate_archive rejects an archive with too many members" {
  local archive="$BATS_TEST_TMPDIR/many-members.tar.gz"
  local workdir="$BATS_TEST_TMPDIR/many-members-src"
  mkdir -p "$workdir"
  local i
  for i in $(seq 1 5); do
    printf 'member %s\n' "$i" >"$workdir/file$i.txt"
  done
  tar -czf "$archive" -C "$workdir" .

  run validate_archive "$archive" 3 1048576
  [ "$status" -ne 0 ]
  [[ "$output" == *"member"* || "$output" == *"too many"* ]]
}

@test "validate_archive rejects an archive exceeding the uncompressed size budget" {
  local archive="$BATS_TEST_TMPDIR/oversized.tar.gz"
  local workdir="$BATS_TEST_TMPDIR/oversized-src"
  mkdir -p "$workdir"
  # Highly compressible payload: small on disk, large uncompressed.
  head -c 1048576 /dev/zero | tr '\0' 'a' >"$workdir/big.txt"
  tar -czf "$archive" -C "$workdir" .

  run validate_archive "$archive" 100 1024
  [ "$status" -ne 0 ]
  [[ "$output" == *"size"* || "$output" == *"budget"* || "$output" == *"too large"* ]]
}

@test "validate_archive accepts an archive within the configured budgets" {
  local archive="$BATS_TEST_TMPDIR/within-budget.tar.gz"
  local workdir="$BATS_TEST_TMPDIR/within-budget-src"
  mkdir -p "$workdir"
  printf 'small payload\n' >"$workdir/small.txt"
  tar -czf "$archive" -C "$workdir" .

  run validate_archive "$archive" 100 1048576
  [ "$status" -eq 0 ]
}

@test "validate_archive rejects duplicate member paths" {
  local archive="$BATS_TEST_TMPDIR/duplicate-members.tar.gz"
  local workdir="$BATS_TEST_TMPDIR/duplicate-src"
  mkdir -p "$workdir"
  printf 'first\n' >"$workdir/dup.txt"
  tar -czf "$archive" -C "$workdir" dup.txt
  # Append the same member name a second time.
  tar -czf "$BATS_TEST_TMPDIR/dup-extra.tar.gz" -C "$workdir" dup.txt
  # Rebuild with the member listed twice by concatenating tar streams.
  cat "$archive" "$BATS_TEST_TMPDIR/dup-extra.tar.gz" >"$BATS_TEST_TMPDIR/dup-combined.tar.gz"
  # Use a plain (uncompressed) tar so duplicate entries can be appended.
  tar -cf "$BATS_TEST_TMPDIR/dup.tar" -C "$workdir" dup.txt
  tar -rf "$BATS_TEST_TMPDIR/dup.tar" -C "$workdir" dup.txt

  run validate_archive "$BATS_TEST_TMPDIR/dup.tar" 100 1048576
  [ "$status" -ne 0 ]
  [[ "$output" == *"duplicate"* || "$output" == *"repeated"* ]]
}

@test "validate_archive rejects equivalently-spelled duplicate member paths" {
  local workdir="$BATS_TEST_TMPDIR/equiv-src"
  mkdir -p "$workdir/sub"
  printf 'payload\n' >"$workdir/sub/file.txt"
  local archive="$BATS_TEST_TMPDIR/equiv.tar"
  tar -cf "$archive" -C "$workdir" sub/file.txt
  # Append an equivalent spelling of the same normalized path.
  tar -rf "$archive" -C "$workdir" ./sub/file.txt

  run validate_archive "$archive" 100 1048576
  [ "$status" -ne 0 ]
  [[ "$output" == *"duplicate"* || "$output" == *"repeated"* ]]
}

@test "restore.sh --help exits 0" {
  run "$REPO_ROOT/scripts/restore.sh" --help
  [ "$status" -eq 0 ]
}

@test "restore.sh rejects an unknown flag" {
  run "$REPO_ROOT/scripts/restore.sh" --not-a-flag
  [ "$status" -eq 1 ]
}

@test "backup.sh accepts a valid artifact name and storage prefix" {
  run validate_artifact_name "soroban-backup-20260101T020000Z.tar.gz.enc"
  [ "$status" -eq 0 ]

  run validate_storage_prefix "backups/soroban"
  [ "$status" -eq 0 ]
}

@test "backup.sh rejects artifact names containing slashes" {
  run validate_artifact_name "backups/soroban-backup.tar.gz.enc"
  [ "$status" -ne 0 ]
  [[ "$output" == *"artifact"* ]]
}

@test "backup.sh rejects artifact names with parent traversal segments" {
  run validate_artifact_name ".."
  [ "$status" -ne 0 ]

  run validate_artifact_name "../soroban-backup.tar.gz.enc"
  [ "$status" -ne 0 ]

  run validate_storage_prefix "backups/../etc"
  [ "$status" -ne 0 ]
  [[ "$output" == *"prefix"* || "$output" == *"traversal"* ]]
}

@test "backup.sh rejects artifact names with control characters" {
  run validate_artifact_name "$(printf 'soroban-backup\t.tar.gz.enc')"
  [ "$status" -ne 0 ]

  run validate_artifact_name "$(printf 'soroban-backup\n.tar.gz.enc')"
  [ "$status" -ne 0 ]

  run validate_storage_prefix "$(printf 'backups/\001soroban')"
  [ "$status" -ne 0 ]
}

@test "backup.sh rejects empty artifact names and prefixes" {
  run validate_artifact_name ""
  [ "$status" -ne 0 ]

  run validate_storage_prefix ""
  [ "$status" -ne 0 ]
}

@test "backup.sh free-space preflight fails when the budget exceeds available space" {
  run check_staging_free_space 1000000000000000 "$BATS_TEST_TMPDIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"free space"* || "$output" == *"insufficient"* ]]
  [[ "$output" == *"backup_staging_free_space"* || "$output" == *"metric"* ]]
}

@test "backup.sh free-space preflight passes when the budget fits" {
  run check_staging_free_space 1 "$BATS_TEST_TMPDIR"
  [ "$status" -eq 0 ]
}
