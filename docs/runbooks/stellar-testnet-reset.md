# Stellar Testnet Reset Recovery Runbook

## Overview

A Stellar testnet reset wipes all ledger state: accounts, balances, contract instances, and contract data are lost. Any contract IDs, funded keypairs, and network-derived data produced before the reset become invalid.

This runbook describes the coordinated recovery procedure after a testnet reset:

1. Detect the reset.
2. Regenerate and fund keypairs.
3. Redeploy contracts and re-run initialization.
4. Reconcile the backend catalog and update contract IDs in deployment config.
5. Verify that no stale contract IDs or network-derived data remain.

> **Important:** Do not run individual steps in isolation. A partial recovery (e.g. redeploying contracts without reconciling the backend catalog) leaves the system in a state where the backend references contract IDs that no longer exist on-chain.

---

## Prerequisites

- `stellar` CLI installed and configured (`stellar --version`).
- Node.js and project dependencies installed (`npm ci`).
- `kubectl` access to the target cluster and namespace.
- Access to the backend secret store (e.g. `backend-secret`).
- The following scripts present in the repository:
  - `scripts/01-generate-keypairs.js`
  - `scripts/02-fund-accounts.js`
  - `scripts/deploy-contracts.cjs`
  - `scripts/05-seed-catalog.js`

Set the network and working directory for all commands below:

```bash
export STELLAR_NETWORK=testnet
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org
export STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
export NAMESPACE=<your-namespace>
cd <repo-root>
```

---

## Step 1 — Detect the reset

A reset has occurred if any of the following are observed.

### 1a. Ledger sequence regression

Record the current ledger sequence and compare it against the last known value (from monitoring, deployment records, or the previous run of this check):

```bash
curl -s "$STELLAR_HORIZON_URL/ledgers?order=desc&limit=1" \
  | jq -r '._embedded.records[0].sequence'
```

Expected output (normal operation): a sequence number **greater than or equal to** the last recorded value.

Reset indicator: the sequence is **lower** than the last recorded value (the network restarted from a fresh genesis ledger).

### 1b. Account not found

Check a previously funded account:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "$STELLAR_HORIZON_URL/accounts/<KNOWN_PUBLIC_KEY>"
```

Expected output (normal operation): `200`.

Reset indicator: `404` — the account no longer exists on-chain.

### 1c. Contract not found

Check a previously deployed contract instance:

```bash
stellar contract invoke \
  --id <KNOWN_CONTRACT_ID> \
  --network "$STELLAR_NETWORK" \
  --source <KNOWN_PUBLIC_KEY> \
  -- --help
```

Expected output (normal operation): the contract's function list.

Reset indicator: an error such as `contract not found`, `HostError: Error(Storage, MissingValue)`, or `account not found` — the contract instance (and/or its deployer account) no longer exists.

If any reset indicator is confirmed, proceed to Step 2. Do not attempt to reuse any previously generated keypairs or contract IDs.

---

## Step 2 — Regenerate and fund keypairs

### 2a. Generate fresh keypairs

```bash
node scripts/01-generate-keypairs.js
```

Expected output: a summary listing each generated role (e.g. admin, deployer, issuer) with its public key, and the keypairs written to the configured output file (e.g. `keys/` or `.env`). Confirm the file was written:

```bash
ls -l keys/ 2>/dev/null || ls -l .env
```

> **Note:** Old keypairs are invalid after a reset. Regenerate rather than reuse.

### 2b. Fund accounts via Friendbot

```bash
node scripts/02-fund-accounts.js
```

Expected output: one line per account, e.g.:

```
Funding GABC...XYZ via Friendbot...
  -> success (tx <hash>)
Funding GDEF...UVW via Friendbot...
  -> success (tx <hash>)
```

Verify each account now exists on-chain:

```bash
for PK in $(node -e "console.log(require('./keys/keypairs.json').map(k=>k.publicKey).join(' '))"); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$STELLAR_HORIZON_URL/accounts/$PK")
  echo "$PK -> $code"
done
```

Expected output: every line ends with `-> 200`.

If any account returns `404`, re-run `scripts/02-fund-accounts.js` for that account (Friendbot can be rate-limited; retry after a short delay).

---

## Step 3 — Redeploy contracts and re-run initialization

### 3a. Deploy contracts

```bash
node scripts/deploy-contracts.cjs
```

Expected output: for each contract, a deployed contract ID, e.g.:

```
Deploying <contract-name>...
  wasm: <path>.wasm
  contract id: CABC...XYZ
  tx: <hash>
...
Wrote contract IDs to contract-ids.env
```

Confirm `contract-ids.env` was written and contains only new IDs:

```bash
cat contract-ids.env
```

Expected output: a list of `NAME=CONTRACT_ID` entries. Every ID must be new (different from any ID recorded before the reset).

### 3b. Re-run contract initialization

Re-run the initialization step for each contract that requires it (admin set, token registration, etc.). Use the project's init script or the deploy script's init flag, for example:

```bash
node scripts/deploy-contracts.cjs --init
```

or invoke the init function directly:

```bash
stellar contract invoke \
  --id "$(grep '^ADMIN_CONTRACT_ID=' contract-ids.env | cut -d= -f2)" \
  --network "$STELLAR_NETWORK" \
  --source <ADMIN_PUBLIC_KEY> \
  -- init --admin <ADMIN_PUBLIC_KEY>
```

Expected output: a successful transaction hash for each init call. If a contract has no init function, skip it.

### 3c. Verify on-chain existence of every contract ID

```bash
while IFS='=' read -r NAME ID; do
  [ -z "$NAME" ] && continue
  if stellar contract invoke --id "$ID" --network "$STELLAR_NETWORK" --source <ADMIN_PUBLIC_KEY> -- --help >/dev/null 2>&1; then
    echo "$NAME ($ID) -> OK"
  else
    echo "$NAME ($ID) -> MISSING"
  fi
done < contract-ids.env
```

Expected output: every line ends with `-> OK`. Any `-> MISSING` line means the deploy or init step failed; resolve before continuing.

---

## Step 4 — Reconcile the backend catalog and deployment config

### 4a. Update contract IDs in deployment config

Update `k8s/configmap.yaml` so that every contract ID matches the new values in `contract-ids.env`:

```bash
# Show the contract IDs currently referenced by the ConfigMap
kubectl -n "$NAMESPACE" get configmap app-config -o yaml | grep -i contract
```

Compare against `contract-ids.env`. Edit `k8s/configmap.yaml` to replace each stale ID with the new one, then apply:

```bash
kubectl -n "$NAMESPACE" apply -f k8s/configmap.yaml
```

Update the `backend-secret` with any new keypair material or contract IDs it holds:

```bash
kubectl -n "$NAMESPACE" create secret generic backend-secret \
  --from-literal=ADMIN_SECRET_KEY="<new-admin-secret>" \
  --from-literal=ADMIN_CONTRACT_ID="$(grep '^ADMIN_CONTRACT_ID=' contract-ids.env | cut -d= -f2)" \
  --dry-run=client -o yaml | kubectl -n "$NAMESPACE" apply -f -
```

> **Note:** Adjust secret keys to match the project's actual `backend-secret` schema. Never commit secret values to the repository.

Restart the backend so it picks up the new config and secret:

```bash
kubectl -n "$NAMESPACE" rollout restart deployment/backend
kubectl -n "$NAMESPACE" rollout status deployment/backend
```

Expected output: `deployment "backend" successfully rolled out`.

### 4b. Re-seed the backend catalog

The catalog contains network-derived data (contract IDs, token addresses, on-chain metadata) that is stale after a reset. Re-seed it:

```bash
node scripts/05-seed-catalog.js
```

Expected output: a summary of seeded entries, e.g.:

```
Seeding catalog...
  inserted <n> entries
  updated <m> entries
  skipped <k> entries
Catalog seed complete.
```

If the script supports a `--reset` or `--truncate` flag, use it to clear stale rows first:

```bash
node scripts/05-seed-catalog.js --reset
```

### 4c. Purge cached RPC responses and stale deployment records

If the backend caches RPC responses (e.g. Redis, in-memory), flush the relevant cache:

```bash
# Example for Redis-backed cache
kubectl -n "$NAMESPACE" exec deploy/redis -- redis-cli FLUSHDB
```

Archive or delete stale deployment records produced before the reset so they are not mistaken for current state:

```bash
mkdir -p deployments/archive
mv deployments/*.json deployments/archive/ 2>/dev/null || true
```

Record the new deployment (contract IDs, ledger sequence, timestamp) for future reset detection:

```bash
{
  echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "ledger=$(curl -s "$STELLAR_HORIZON_URL/ledgers?order=desc&limit=1" | jq -r '._embedded.records[0].sequence')"
  cat contract-ids.env
} > "deployments/$(date -u +%Y%m%dT%H%M%SZ).env"
```

---

## Step 5 — Verification checklist

Run every check below. All must pass before declaring recovery complete.

### 5a. No stale contract IDs

- [ ] **`contract-ids.env` matches on-chain existence.** Every ID in `contract-ids.env` resolves on-chain (Step 3c). Expected: all `-> OK`.
- [ ] **`contract-ids.env` matches the running ConfigMap.** Compare the two:

  ```bash
  diff <(sort contract-ids.env) \
       <(kubectl -n "$NAMESPACE" get configmap app-config -o yaml \
           | grep -E '^[[:space:]]+[A-Z_]+_CONTRACT_ID:' \
           | sed -E 's/^[[:space:]]+//; s/: / = /' \
           | sort)
  ```

  Expected output: no differences. Any output indicates a stale contract ID in the ConfigMap or in `contract-ids.env`.

- [ ] **`backend-secret` matches the running ConfigMap.** Confirm the secret's contract ID entries equal the ConfigMap's:

  ```bash
  kubectl -n "$NAMESPACE" get secret backend-secret -o jsonpath='{.data}' \
    | jq -r 'to_entries[] | select(.key|test("CONTRACT_ID")) | "\(.key)=\(.value|@base64d)"' \
    | sort
  ```

  Expected output: matches the corresponding entries in `contract-ids.env`.

- [ ] **No old contract IDs remain in the repository or cluster.** Search for any ID recorded before the reset:

  ```bash
  grep -rn "<OLD_CONTRACT_ID>" . --exclude-dir=node_modules --exclude-dir=.git
  kubectl -n "$NAMESPACE" get configmap,secret -o yaml | grep "<OLD_CONTRACT_ID>"
  ```

  Expected output: no matches.

### 5b. No stale network-derived data

- [ ] **Catalog rows reference current contract IDs.** Query the backend catalog and confirm every contract ID it returns is present in `contract-ids.env`:

  ```bash
  # Adjust the endpoint/query to the project's catalog API
  curl -s "http://localhost:8080/api/catalog" | jq -r '.[].contractId' | sort -u
  ```

  Expected output: a subset of the IDs in `contract-ids.env`. Any ID not in `contract-ids.env` is stale — re-run Step 4b.

- [ ] **Cached RPC responses are cleared.** Confirm the cache holds no entries older than the reset:

  ```bash
  kubectl -n "$NAMESPACE" exec deploy/redis -- redis-cli DBSIZE
  ```

  Expected output: `0` (or only entries created after Step 4c).

- [ ] **Deployment records are current.** Confirm the newest record in `deployments/` has a timestamp after the reset and contract IDs matching `contract-ids.env`:

  ```bash
  ls -t deployments/*.env | head -1 | xargs cat
  ```

  Expected output: a timestamp after the reset and the current contract IDs.

- [ ] **Backend health check passes.** Confirm the backend reports healthy and can reach the network:

  ```bash
  kubectl -n "$NAMESPACE" exec deploy/backend -- curl -s http://localhost:8080/health
  ```

  Expected output: `{"status":"ok",...}` (or the project's equivalent healthy response).

### 5c. End-to-end smoke test

- [ ] Perform one read and one write against a redeployed contract through the backend. Expected: both succeed and the write is visible on-chain (verify with `stellar contract invoke` or a Horizon/RPC query).

---

## Rollback

If verification fails and the cause cannot be resolved:

1. Do **not** restore pre-reset contract IDs or keypairs — they are invalid on-chain.
2. Re-run Steps 2–4 from the beginning.
3. If the backend is serving stale data, scale it down, flush the cache, re-seed the catalog, and scale it back up:

   ```bash
   kubectl -n "$NAMESPACE" scale deployment/backend --replicas=0
   kubectl -n "$NAMESPACE" exec deploy/redis -- redis-cli FLUSHDB
   node scripts/05-seed-catalog.js --reset
   kubectl -n "$NAMESPACE" scale deployment/backend --replicas=1
   ```

---

## Post-recovery

- Record the new ledger sequence and contract IDs (Step 4c) so the next reset can be detected via Step 1a.
- Update any monitoring dashboards or alerts that reference the old contract IDs.
- Notify downstream consumers of the new contract IDs.