# Contract Deploy Guide

This guide walks through deploying the Soroban contracts and wiring up the backend.

## Prerequisites

- Rust toolchain with the `wasm32-unknown-unknown` target
- Stellar CLI (`stellar`)
- A funded deployer account on the target network
- Backend environment configured (see `.env.example`)
---

## Automated deployment (preferred)

```bash
# 1. Build the WASM in your SynapsVault/contracts checkout
(cd ../contracts && cargo build --target wasm32-unknown-unknown --release --workspace)

# 2. Keep a copy of the current IDs so you can roll back later
cp contract-ids.env "contract-ids.env.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true

# 3. Deploy all contracts (uploads WASM, deploys, calls init(admin), verifies,
#    writes contract-ids.env). Add --dry-run to run only the pre-flight checks.
STELLAR_SECRET_KEY=S... \
ADMIN_PUBLIC_KEY=G...   `# optional; defaults to the deployer` \
CONTRACTS_WASM_DIR=../contracts/target/wasm32-unknown-unknown/release \
npm run deploy:contracts -- --network testnet

# Roll back: point the backend at a previous set of contract IDs
npm run rollback:contracts -- --backup contract-ids.env.<timestamp> \
  --network testnet --target-env .env [--configmap backend-config] [--dry-run]
```

The deploy script performs pre-flight checks (valid key, funded account, WASM
present), deploys `vault-registry`, `access-lease` and `subscription`,
initialises each with `init(admin)`, and writes the resulting contract IDs to
`contract-ids.env`. Mainnet requires typing a confirmation, or `--yes` in CI.

Soroban contracts are immutable, so rollback never removes anything on-chain:
it verifies that each contract in the backup file still exists on-chain, then
rewrites those IDs in the target `.env` file and (optionally) merge-patches the
Kubernetes ConfigMap. Restart the backend afterwards to pick up the change.

---

## Contract TTL inspection and extension

Soroban contract **instances** and their **WASM code** entries are stored in
ledger entries that expire unless their time-to-live (TTL) is extended. If an
entry expires, calls to the contract fail until it is restored. After every
deploy the script therefore inspects the remaining TTL of each contract's
instance entry and code entry and records the observed ledger values (current
ledger sequence and the live-until ledger of each entry) in its output and in
`contract-ids.env`-adjacent deploy logs.

### Configuring the minimum thresholds

The script compares the observed TTL against configurable minimums and warns
(or fails, with `--strict-ttl`) when an entry is below them:

| Option | Env var | Meaning |
| --- | --- | --- |
| `--min-instance-ttl <ledgers>` | `MIN_INSTANCE_TTL_LEDGERS` | Minimum remaining ledgers for contract instance entries |
| `--min-code-ttl <ledgers>` | `MIN_CODE_TTL_LEDGERS` | Minimum remaining ledgers for contract code (WASM) entries |

```bash
# Warn if either entry has less than ~30 days of TTL left
# (Stellar ledgers close roughly every 5 seconds, so 30 days ≈ 518,400 ledgers)
MIN_INSTANCE_TTL_LEDGERS=518400 MIN_CODE_TTL_LEDGERS=518400 \
npm run deploy:contracts -- --network testnet

# Or pass the thresholds explicitly; --strict-ttl turns warnings into a failure
npm run deploy:contracts -- --network testnet \
  --min-instance-ttl 518400 --min-code-ttl 518400 --strict-ttl
```

### Interpreting the results

- **OK** — remaining TTL is at or above the configured minimum for both the
  instance and code entries.
- **WARN** — an entry is below the minimum. The deploy still succeeds, but
  extend the TTL before it expires (see below).
- **FAIL** — with `--strict-ttl`, a below-minimum entry aborts the run with a
  non-zero exit code. Use this in CI so a deploy that leaves contracts close to
  expiry is caught immediately.

If the script cannot read an entry's TTL (e.g. the contract ID does not exist
on the target network), treat it as a failure and re-check the contract IDs.

### Extending TTL

Extend both the **instance** entry and the **code** entry for every deployed
contract. Using the Stellar CLI:

```bash
# Extend the contract instance entry
stellar contract extend \
  --id "$STELLAR_CONTRACT_VAULT_REGISTRY" \
  --source <admin-secret-key> \
  --network testnet \
  --ledger 518400

# Extend the contract code (WASM) entry — pass the WASM hash of the deployed code
stellar contract extend \
  --id "$STELLAR_CONTRACT_VAULT_REGISTRY" \
  --source <admin-secret-key> \
  --network testnet \
  --wasm-hash <wasm-hash> \
  --ledger 518400
```

Repeat for `access-lease` and `subscription`. `--ledger` is the number of
ledgers to extend the entry's TTL by (relative to the current ledger), so pick a
value that comfortably exceeds your minimum threshold.

From the SDK, use `extendFootprintTtl` to extend the entries touched by a
simulated invocation, or `extendContractInstance` to extend a contract's
instance entry directly:

```js
const { SorobanRpc, TransactionBuilder, Networks, Operation } = require('@stellar/stellar-sdk');

// Extend the instance entry of a deployed contract
const op = Operation.extendContractInstance({
  contract: contractId,
  extendTo: currentLedger + 518400,
});

// Or extend the footprint (instance + code) of a simulated invocation
const extendOp = Operation.extendFootprintTtl({ extendTo: currentLedger + 518400 });
```

After extending, re-run the TTL inspection (or the deploy script with
`--dry-run`) to confirm the new live-until ledger values are above the
configured minimums, and record them in the deployment notes.

> **Testnet resets:** a Stellar testnet reset wipes all ledger state, including
> contracts and their TTLs. Follow the
> [testnet reset recovery runbook](./testnet-reset-recovery.md) to re-fund
> accounts, redeploy contracts and reconcile the backend catalog.

---

## Updating the backend ConfigMap after a contract deploy

The backend ConfigMap (`k8s/configmap.yaml`) tracks the contract IDs in Git so
that `kubectl apply` and the running config never drift. The keys are:

```yaml
STELLAR_CONTRACT_VAULT_REGISTRY: "CC..."
STELLAR_CONTRACT_ACCESS_LEASE: "CD..."
STELLAR_CONTRACT_SUBSCRIPTION: "CE..."
```

After a contract deploy, update them in Git and re-apply:

```bash
# 1. Deploy (writes contract-ids.env) — see the automated section above
npm run deploy:contracts -- --network testnet

# 2. Copy the new IDs from contract-ids.env into k8s/configmap.yaml
#    (replace the placeholder values for the three STELLAR_CONTRACT_* keys)

# 3. Commit the ConfigMap change so Git stays the source of truth
git add k8s/configmap.yaml
git commit -m "chore: update contract IDs in backend ConfigMap"

# 4. Apply and restart the backend to pick up the new IDs
kubectl apply -f k8s/configmap.yaml
kubectl rollout restart deployment/backend
```

> **Rollback:** `npm run rollback:contracts -- --backup contract-ids.env.<timestamp>
> --configmap backend-config` merge-patches the live ConfigMap. Always mirror the
> resulting IDs back into `k8s/configmap.yaml` and commit, otherwise the next
> `kubectl apply` will revert the running config to the stale Git values.

---

## Mainnet deployment safety checks
## Mainnet deployment safety checks & production requirements

While the quickstart steps below focus on **Testnet**, deploying to **Stellar Mainnet** requires strict operational controls in addition to the automated script's pre-flight checks:

### 1. Automated script pre-flight checks
- **Network guard** — refuses to run against mainnet unless `--network mainnet`
  is passed explicitly; defaults to testnet.
- **Keypair validation** — verifies the deployer secret key is present, well-formed,
  and matches the expected public key.
- **Balance check** — confirms the deployer account holds enough XLM to cover
  upload and deployment fees.
- **WASM hash check** — builds the contracts and compares the resulting WASM hashes
  against the recorded hashes to detect unintended changes.
- **Contract ID check** — warns if any target contract ID already exists on-chain.
- **Confirmation prompt** — prints a summary of the network, deployer, contract IDs
  and WASM hashes, then requires you to type `deploy mainnet` (or pass `--yes` in CI) to proceed.

### 2. Mainnet production readiness gate
Before promoting to Mainnet, verify and sign off on every item below:

- **Dedicated Soroban RPC** — Do **not** use public/shared testnet RPC endpoints (`deploy-contracts.cjs` intentionally has no default RPC URL for `mainnet`). Provision a dedicated, SLA-backed Soroban RPC provider (e.g., Blockdaemon, Validation Cloud, QuickNode, or self-hosted `stellar-rpc`) with rate-limit headroom and a secondary failover endpoint configured in `SOROBAN_RPC_URL`.
- **Key Custody** — Never generate or store mainnet keys in plain `.env` files on developer laptops. Generate and custody the deployer and admin keys in hardware security modules (HSM), cloud KMS, or a multi-signature Stellar account (`2-of-3` or `3-of-5` signers).
- **Contract Audits** — Complete an independent security audit of `vault-registry`, `access-lease`, and `subscription` WASM artifacts. Pin the audited git commit SHA and verify the compiled SHA-256 WASM digest before uploading.
- **Admin Key Handling** — Separate the one-time `DEPLOYER` account from `ADMIN_PUBLIC_KEY`. Set `ADMIN_PUBLIC_KEY` to a dedicated admin/multisig account, restrict backend runtime keys to lease-granting operations only, and rehearse key rotation on testnet before launch.
- **Monitoring & Alerting Sign-Off** — Confirm Prometheus scrape targets, Alertmanager routing (PagerDuty/Slack), Grafana dashboards (`docs/MONITORING.md`), and automated encrypted backups (`docs/BACKUP-RESTORE.md`) are active and verified prior to opening mainnet traffic.

Only proceed once every check passes and you have reviewed the printed summary.

---

## Prerequisites (install once)

## 1. Build the contracts

```bash
cargo build --target wasm32-unknown-unknown --release
```

Artifacts are written to `target/wasm32-unknown-unknown/release/*.wasm`.

## 2. Deploy

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/<contract>.wasm \
  --source <deployer-secret-key> \
  --network <network>
```

Record the returned contract ID and the deployer public key.

## 3. Initialize

```bash
stellar contract invoke \
  --id <contract-id> \
  --source <admin-secret-key> \
  --network <network> \
  -- initialize --admin <admin-public-key>
```

The account passed as `--admin` becomes the contract admin and is the only
account allowed to perform privileged operations (e.g. setting the backend
signer, pausing, upgrading).

## 4. Configure the backend

Set the contract IDs and the backend signing key in the backend environment
(see `.env.example` for the full list of variables).

---

## Key rotation

Privileged keys can be compromised or need periodic rotation. The table below
summarizes the roles and how each is rotated.

| Role | Where it lives | Rotation mechanism |
| --- | --- | --- |
| Contract admin | On-chain admin account | `set_admin` (admin-signed) |
| Deployer | Off-chain keypair used for `stellar contract deploy` | New keypair; no on-chain state to change |
| Backend signer | Backend wallet / signing key | `set_signer` (admin-signed) + backend secret update |

> Always rotate to a **freshly generated** keypair. Never reuse a key that may
> have been exposed.

### Rotating the contract admin

1. Generate a new admin keypair and fund it on the target network.
2. From the **current** admin account, transfer the admin role:

   ```bash
   stellar contract invoke \
     --id <contract-id> \
     --source <current-admin-secret-key> \
     --network <network> \
     -- set_admin --new_admin <new-admin-public-key>
   ```

3. Verify the new admin is active by performing a harmless admin-only call
   (e.g. reading the current signer) signed with the new key.
4. Revoke/retire the old admin key: remove it from any secret store and stop
   using it. If it was compromised, treat all admin-signed history as suspect
   and review recent privileged operations.
5. Update the admin key wherever it is referenced:
   - CI/CD secrets used for admin operations
   - Operator password managers / hardware wallets
   - Any runbooks or docs that name the old key

### Rotating the deployer

The deployer key is only used to submit `stellar contract deploy`. It holds no
on-chain privileges after deployment, so rotation is purely operational:

1. Generate a new deployer keypair and fund it.
2. Update the deployer secret in CI/CD (e.g. the `DEPLOYER_SECRET_KEY` secret)
   and in any local operator environment.
3. Remove the old deployer key from all secret stores.
4. If the old deployer key was compromised, audit deployments made with it and
   confirm the deployed contract IDs and admin are the expected ones.

### Rotating the backend signing key

The backend signs transactions with a wallet key. Rotate it as follows:

1. Generate a new backend signing keypair and fund it.
2. From the **admin** account, point the contract at the new signer:

   ```bash
   stellar contract invoke \
     --id <contract-id> \
     --source <admin-secret-key> \
     --network <network> \
     -- set_signer --signer <new-backend-public-key>
   ```

3. Update the backend secret with the new signing key (see config updates
   below) and redeploy/restart the backend so it picks up the new key.
4. Verify the backend can submit a signed transaction successfully.
5. Remove the old signing key from all secret stores.

### Config and secret updates

After any rotation, update every place the key is referenced:

- **Backend environment** — update the relevant variable in `.env` / the
  deployment environment (see `.env.example` for names such as the backend
  signing key and contract IDs).
- **Kubernetes secrets** — update the secret object and restart the affected
  pods so the new value is loaded:

  ```bash
  kubectl create secret generic <secret-name> \
    --from-literal=<key-var>=<new-value> \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl rollout restart deployment/<backend-deployment>
  ```

- **CI/CD secrets** — update the deployer/admin secrets in the CI provider so
  automated deploys and admin operations use the new keys.
- **Local operator environments** — update `.env` files and password managers;
  delete the old entries.

After updating, confirm no service still references the old key (search secret
stores and CI config for the old public key) and that the backend and admin
operations succeed with the new keys.
## Rotating a Compromised Contract Admin or Backend Signing Key

If the contract `admin` key or the backend signing key (`BACKEND_SECRET` / `STELLAR_SECRET_KEY`) is compromised:

1. **Generate a fresh keypair**:
   ```bash
   node scripts/01-generate-keypairs.js
   ```
   Fund the new account before proceeding (`node scripts/02-fund-accounts.js GNEW...` on testnet, or transfer XLM on mainnet).

2. **Rotate on-chain contract admin**:
   - **Contracts supporting admin transfer**: invoke `set_admin` on `access-lease` and `subscription` using the current admin signer to transfer authority to `GNEW_BACKEND_PUBLIC`:
     ```bash
     stellar contract invoke \
       --id "$STELLAR_CONTRACT_ACCESS_LEASE" \
       --source current_admin --network testnet \
       -- set_admin --new_admin GNEW_BACKEND_PUBLIC

     stellar contract invoke \
       --id "$STELLAR_CONTRACT_SUBSCRIPTION" \
       --source current_admin --network testnet \
       -- set_admin --new_admin GNEW_BACKEND_PUBLIC
     ```
   - **Immutable contracts or lost admin key**: redeploy the contracts initialized with the new admin key using `deploy-contracts.cjs`:
     ```bash
     rm -f contract-ids.env
     STELLAR_SECRET_KEY=SNEW_DEPLOYER_SECRET \
     ADMIN_PUBLIC_KEY=GNEW_BACKEND_PUBLIC \
     npm run deploy:contracts -- --network testnet
     ```

3. **Update backend secrets and contract IDs**:
   - Replace `STELLAR_SECRET_KEY` / `BACKEND_SECRET_KEY` in your secret store (`backend-secret` in Kubernetes or Railway environment variables).
   - If new contract instances were deployed, propagate the new `contract-ids.env` values to the backend environment and restart the service.
   - Verify with `node scripts/06-smoke-test.js`.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `account not found` | Fund the account with Friendbot first |
| `Error: wasm too large` | Run with `--release` flag |
| `insufficient balance` | Fund deployer wallet — needs XLM for fees |
| `contract already exists` | Use `--wasm-hash` flag to reuse existing upload |
| `Error: HostError: Value(InvalidInput)` | Check argument types match contract signature |
