#!/usr/bin/env bash
# Collect failure diagnostics for the deploy job (#159).
# All output is sanitized before it reaches the artifact store.
set -uo pipefail

NAMESPACE="${1:?usage: collect-diagnostics.sh <namespace> [outdir]}"
OUT="${2:-deploy-diagnostics}"
mkdir -p "$OUT"

sanitize() {
  node "$(dirname "$0")/sanitize-diagnostics.mjs"
}

capture() {
  local name="$1"; shift
  if "$@" 2>&1 | sanitize > "$OUT/$name.txt"; then
    echo "captured $name"
  else
    echo "unavailable $name" > "$OUT/$name.txt"
  fi
}

echo "namespace=${NAMESPACE}" > "$OUT/summary.txt"
echo "captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT/summary.txt"

capture pods kubectl -n "$NAMESPACE" get pods -o wide
capture pod_yaml kubectl -n "$NAMESPACE" get pods -o yaml
capture events kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp
capture migration_job kubectl -n "$NAMESPACE" get job backend-migrate -o yaml
capture deployments kubectl -n "$NAMESPACE" get deployments -o yaml

# Never let a failing diagnostic command fail the already-failed deploy job.
exit 0
