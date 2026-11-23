#!/usr/bin/env node
'use strict';

/**
 * Automated Soroban contract deployment script.
 *
 * Deploys the vault-registry, access-lease, and subscription contracts to a
 * Soroban network, initializes each with the admin key, writes the resulting
 * contract IDs to contract-ids.env, and verifies each contract on-chain.
 *
 * ⚠️  TESTNET IS THE HARD-CODED DEFAULT NETWORK.
 * While this script can deploy to mainnet via the --network or NETWORK flag,
 * testnet is the intended primary target. Mainnet deployments require explicit
 * confirmation and are only available with the --yes flag in non-interactive mode.
 *
 * Usage:
 *   node scripts/deploy-contracts.cjs [--network testnet|mainnet|futurenet] [--wasm-dir <dir>] [--yes] [--dry-run]
 *
 * Required environment variables:
 *   STELLAR_SECRET_KEY  - Secret key of the deploying account.
 *   NETWORK             - Target network (testnet|mainnet|futurenet). Overridden by --network.
 *                         Defaults to testnet if not specified.
 *
 * Optional environment variables:
 *   SOROBAN_RPC_URL     - Soroban RPC endpoint (defaults to the public testnet
 *                         RPC for testnet; required for mainnet/futurenet).
 *   CONTRACTS_WASM_DIR  - Directory containing the built *.wasm files. Overridden
 *                         by --wasm-dir. Defaults to ./target/wasm32-unknown-unknown/release.
 *   ADMIN_PUBLIC_KEY    - Address passed to each contract's init(admin). Defaults
 *                         to the deployer's public key.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const {
  Keypair,
  Networks,
  Contract,
  TransactionBuilder,
  Operation,
  Address,
  scValToNative,
  rpc,
  xdr,
  StrKey,
} = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT_DIR = path.resolve(__dirname, '..');
const CONTRACT_IDS_FILE = path.join(ROOT_DIR, 'contract-ids.env');

const NETWORK_PASSPHRASES = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
};

const DEFAULT_RPC_URLS = {
  testnet: 'https://soroban-testnet.stellar.org',
  futurenet: 'https://rpc-futurenet.stellar.org',
};

const DEFAULT_WASM_DIR = path.join(ROOT_DIR, 'target', 'wasm32-unknown-unknown', 'release');

// Each contract exposes `init(admin: Address)`.
const CONTRACTS = [
  { name: 'vault-registry', wasmFile: 'vault_registry.wasm' },
  { name: 'access-lease', wasmFile: 'access_lease.wasm' },
  { name: 'subscription', wasmFile: 'subscription.wasm' },
];

// Canonical env var prefix for the deployed contract IDs (the names the backend
// reads), e.g. `vault-registry` -> `STELLAR_CONTRACT_VAULT_REGISTRY`.
const CONTRACT_ENV_PREFIX = 'STELLAR_CONTRACT_';

function contractEnvName(contractName) {
  return `${CONTRACT_ENV_PREFIX}${contractName.toUpperCase().replace(/-/g, '_')}`;
}

// Minimum account balance (in stroops) required to proceed with deployment.
// 10 XLM accommodates uploading 3 WASM contracts (each ~300-500KB).
const MIN_BALANCE_STROOPS = 100_000_000n; // 10 XLM

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    network: null,
    dryRun: false,
    plan: false,
    yes: false,
    wasmDir: null,
    manifest: null,
    verifyRecord: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--plan') {
      args.plan = true;
      args.dryRun = true;
    } else if (arg === '--yes' || arg === '-y') {
      args.yes = true;
    } else if (arg === '--wasm-dir') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--wasm-dir requires a value');
      }
      args.wasmDir = value;
    } else if (arg.startsWith('--wasm-dir=')) {
      args.wasmDir = arg.slice('--wasm-dir='.length);
    } else if (arg === '--manifest') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--manifest requires a value');
      }
      args.manifest = value;
    } else if (arg.startsWith('--manifest=')) {
      args.manifest = arg.slice('--manifest='.length);
    } else if (arg === '--verify-record') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--verify-record requires a value');
      }
      args.verifyRecord = value;
    } else if (arg.startsWith('--verify-record=')) {
      args.verifyRecord = arg.slice('--verify-record='.length);
    } else if (arg === '--network') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--network requires a value (testnet|mainnet)');
      }
      args.network = value;
    } else if (arg.startsWith('--network=')) {
      args.network = arg.slice('--network='.length);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.network && !NETWORK_PASSPHRASES[args.network]) {
    throw new Error(
      `Invalid --network value: ${args.network} (expected testnet|mainnet|futurenet or set SOROBAN_RPC_URL for local)`
    );
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/deploy-contracts.cjs [options]

Options:
  --network <testnet|mainnet|futurenet>  Target network (defaults to $NETWORK).
                                         For local Stellar/Quickstart node, set SOROBAN_RPC_URL.
  --wasm-dir <dir>                       Directory containing the built contract *.wasm files
                                         (defaults to $CONTRACTS_WASM_DIR, then ./target/wasm32-unknown-unknown/release).
  --manifest <path>                      JSON manifest mapping WASM artifact filenames to expected
                                         SHA-256 checksums. Artifacts are validated before any
                                         transaction is signed.
  --verify-record <path>                 Re-read a deployment record, fetch current on-chain
                                         executable hashes, and report mismatches (read-only).
  --yes, -y                              Skip the interactive mainnet confirmation (for CI).
  --dry-run                              Perform all checks without submitting transactions.
  --plan                                 Read-only planning mode: report network, artifact hashes,
                                         signer public key and planned operations without signing
                                         or submitting anything (implies --dry-run).
  --help, -h                             Show this help message.
`);
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

const log = {
  info: (msg) => console.log(`[info]  ${msg}`),
  step: (msg) => console.log(`\n==> ${msg}`),
  ok: (msg) => console.log(`[ok]    ${msg}`),
  warn: (msg) => console.warn(`[warn]  ${msg}`),
  error: (msg) => console.error(`[error] ${msg}`),
};

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function validateEnv(args) {
  const missing = [];

  const secretKey = process.env.STELLAR_SECRET_KEY;
  if (!secretKey) {
    missing.push('STELLAR_SECRET_KEY');
  }

  // Default to testnet if network is not specified (testnet is hard-coded default).
  const network = args.network || process.env.NETWORK || 'testnet';

  if (!NETWORK_PASSPHRASES[network]) {
    if (!process.env.SOROBAN_RPC_URL) {
      throw new Error(
        `Invalid NETWORK value: ${network} (expected testnet|mainnet|futurenet or set SOROBAN_RPC_URL for local)`
      );
    }
  }

  const rpcUrl = process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URLS[network];
  if (!rpcUrl) {
    missing.push('SOROBAN_RPC_URL');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables:\n  - ${missing.join('\n  - ')}`);
  }

  let keypair;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch (err) {
    throw new Error(`STELLAR_SECRET_KEY is not a valid Stellar secret key: ${err.message}`);
  }

  const adminAddress = process.env.ADMIN_PUBLIC_KEY || keypair.publicKey();
  if (!StrKey.isValidEd25519PublicKey(adminAddress)) {
    throw new Error(`ADMIN_PUBLIC_KEY is not a valid Stellar public key: ${adminAddress}`);
  }

  const wasmDir = path.resolve(args.wasmDir || process.env.CONTRACTS_WASM_DIR || DEFAULT_WASM_DIR);
  const contracts = CONTRACTS.map((c) => ({ ...c, wasm: path.join(wasmDir, c.wasmFile) }));

  return { keypair, network, rpcUrl, adminAddress, contracts };
}

// ---------------------------------------------------------------------------
// Build manifest / artifact checksums
// ---------------------------------------------------------------------------

/**
 * Load an optional build manifest mapping WASM artifact filenames (or paths)
 * to expected SHA-256 checksums. Returns null when no manifest is configured.
 *
 * Accepted shapes:
 *   { "vault_registry.wasm": "<sha256 hex>", ... }
 *   { "artifacts": { "vault_registry.wasm": "<sha256 hex>" } }
 *   { "artifacts": [ { "file": "vault_registry.wasm", "sha256": "<hex>" } ] }
 */
function loadManifest(manifestPath) {
  if (!manifestPath) return null;

  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Build manifest not found: ${resolved}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`Build manifest is not valid JSON (${resolved}): ${err.message}`);
  }

  const entries = new Map();
  const addEntry = (file, checksum) => {
    if (typeof file !== 'string' || typeof checksum !== 'string') {
      throw new Error(`Build manifest entry must map a filename to a checksum string: ${file}`);
    }
    const normalized = checksum.trim().toLowerCase().replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error(`Build manifest checksum for "${file}" is not a valid SHA-256 hex digest`);
    }
    entries.set(path.basename(file), normalized);
  };

  const source = parsed && parsed.artifacts ? parsed.artifacts : parsed;
  if (Array.isArray(source)) {
    for (const item of source) {
      if (!item || typeof item !== 'object') {
        throw new Error('Build manifest artifact entries must be objects');
      }
      addEntry(item.file || item.name, item.sha256 || item.checksum);
    }
  } else if (source && typeof source === 'object') {
    for (const [file, checksum] of Object.entries(source)) {
      addEntry(file, checksum);
    }
  } else {
    throw new Error(`Build manifest has an unsupported shape: ${resolved}`);
  }

  return { path: resolved, entries };
}

function hashWasmFile(wasmPath) {
  const data = fs.readFileSync(wasmPath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Validate every artifact against the manifest. Throws before any transaction
 * is built or signed when an artifact is missing from the manifest or its
 * checksum does not match.
 */
function validateManifest(manifest, contracts) {
  if (!manifest) {
    log.warn('No build manifest provided; skipping artifact checksum validation.');
    return {};
  }

  log.step('Validating artifact checksums against build manifest');
  const hashes = {};
  const problems = [];

  for (const contract of contracts) {
    const expected = manifest.entries.get(path.basename(contract.wasmFile));
    if (!expected) {
      problems.push(`"${contract.name}" (${contract.wasmFile}) is missing from the build manifest`);
      continue;
    }
    if (!fs.existsSync(contract.wasm)) {
      problems.push(`"${contract.name}" WASM file not found: ${contract.wasm}`);
      continue;
    }
    const actual = hashWasmFile(contract.wasm);
    hashes[contract.name] = actual;
    if (actual !== expected) {
      problems.push(
        `"${contract.name}" checksum mismatch: expected ${expected}, got ${actual} (${contract.wasm})`
      );
    } else {
      log.ok(`Checksum verified for "${contract.name}": ${actual}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Artifact checksum validation failed; refusing to sign any deployment transaction:\n  - ${problems.join('\n  - ')}`
    );
  }

  return hashes;
}

// ---------------------------------------------------------------------------
// Concurrency guard (lockfile keyed by network + signer)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

function lockFilePath(network, publicKey) {
  return path.join(ROOT_DIR, `.deploy-lock-${network}-${publicKey}.lock`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Acquire an exclusive deployment lock for the given network + signer.
 * Fails fast when another live deployment holds the lock. Stale locks (dead
 * PID or older than LOCK_STALE_MS) are reclaimed.
 */
function acquireLock(network, publicKey) {
  const file = lockFilePath(network, publicKey);
  const payload = JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    network,
    publicKey,
    timestamp: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      log.ok(`Acquired deployment lock ${path.basename(file)}`);
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        existing = null;
      }

      const age = existing && existing.timestamp ? Date.now() - Date.parse(existing.timestamp) : Infinity;
      const alive = existing ? isProcessAlive(existing.pid) : false;
      const stale = !existing || !alive || age > LOCK_STALE_MS;

      if (!stale) {
        throw new Error(
          `Another deployment holds the lock for ${network} / ${publicKey} ` +
            `(pid ${existing.pid}, host ${existing.hostname || 'unknown'}, since ${existing.timestamp}). ` +
            `Wait for it to finish or remove ${file} if it is stale.`
        );
      }

      log.warn(`Reclaiming stale deployment lock ${path.basename(file)}`);
      try {
        fs.unlinkSync(file);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }

  throw new Error(`Unable to acquire deployment lock ${file}`);
}

function releaseLock(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
    log.info(`Released deployment lock ${path.basename(file)}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`Failed to release deployment lock ${file}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Mainnet confirmation prompt
// ---------------------------------------------------------------------------

function confirmMainnet(network, assumeYes) {
  if (network !== 'mainnet' || assumeYes) {
    return Promise.resolve(true);
  }

  if (!process.stdin.isTTY) {
    log.error('Refusing to deploy to mainnet non-interactively without --yes.');
    return Promise.resolve(false);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      '\n*** WARNING: You are about to deploy to MAINNET. ***\n' +
        'Type "deploy mainnet" to confirm: ',
      (answer) => {
        rl.close();
        resolve(answer.trim() === 'deploy mainnet');
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

async function preflightChecks({ server, keypair, network, contracts, dryRun, manifest }) {
  log.step('Running pre-flight checks');

  // 0. Artifact checksum validation (before any transaction is signed).
  validateManifest(manifest, contracts);

  // 1. Network passphrase sanity check.
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  if (!networkPassphrase) {
    throw new Error(`No network passphrase configured for "${network}"`);
  }
  log.ok(`Network passphrase resolved for "${network}"`);

  // 2. Account existence and balance.
  const publicKey = keypair.publicKey();
  log.info(`Deployer account: ${publicKey}`);

  // Soroban RPC's getAccount() returns a bare Account (sequence only), so read
  // the full ledger entry to get the native balance.
  let accountEntry;
  try {
    accountEntry = await server.getAccountEntry(publicKey);
  } catch (err) {
    throw new Error(
      `Unable to load deployer account ${publicKey} from Soroban RPC. ` +
        `Ensure the account is funded on ${network}. (${err.message})`
    );
  }

  // Older SDKs expose XDR fields as accessor methods; v17+ as plain properties.
  const rawBalance =
    typeof accountEntry.balance === 'function' ? accountEntry.balance() : accountEntry.balance;
  const balanceStroops = BigInt(rawBalance.toString());
  const balanceXlm = (Number(balanceStroops) / 1e7).toFixed(7);
  log.info(`Native balance: ${balanceXlm} XLM`);

  if (balanceStroops < MIN_BALANCE_STROOPS) {
    throw new Error(
      `Insufficient balance: ${balanceXlm} XLM. ` +
        `At least ${Number(MIN_BALANCE_STROOPS) / 1e7} XLM is required.`
    );
  }
  log.ok('Account balance is sufficient');

  // 3. Contract WASM existence.
  for (const contract of contracts) {
    if (!fs.existsSync(contract.wasm)) {
      throw new Error(
        `WASM file not found for "${contract.name}": ${contract.wasm}\n` +
          'Build the contracts first (e.g. `cargo build --target wasm32-unknown-unknown --release`).'
      );
    }
    const size = fs.statSync(contract.wasm).size;
    log.ok(`Found WASM for "${contract.name}" (${size} bytes)`);
  }

  if (dryRun) {
    log.warn('Dry run enabled: no transactions will be submitted.');
  }
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

async function submitTransaction({ server, tx, keypair, dryRun, label }) {
  if (dryRun) {
    log.info(`[dry-run] Skipping submission: ${label}`);
    return null;
  }

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);

  const sendResponse = await server.sendTransaction(prepared);
  if (sendResponse.status === 'ERROR') {
    throw new Error(
      `Transaction submission failed for ${label}: ${JSON.stringify(sendResponse.errorResult || sendResponse)}`
    );
  }

  const hash = sendResponse.hash;
  log.info(`Submitted ${label} (hash: ${hash}); awaiting confirmation...`);

  const result = await pollTransaction(server, hash);
  if (result.status !== 'SUCCESS') {
    throw new Error(`Transaction ${hash} for ${label} did not succeed: ${result.status}`);
  }

  log.ok(`Confirmed ${label} (hash: ${hash})`);
  return result;
}

async function pollTransaction(server, hash, { attempts = 30, intervalMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const response = await server.getTransaction(hash);
    if (response.status !== 'NOT_FOUND') {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for transaction ${hash}`);
}

// ---------------------------------------------------------------------------
// WASM upload
// ---------------------------------------------------------------------------

async function uploadWasm({ server, keypair, networkPassphrase, wasmPath, dryRun, contractName }) {
  log.step(`Uploading WASM for "${contractName}"`);

  const wasm = fs.readFileSync(wasmPath);

  if (dryRun) {
    log.info(`[dry-run] Would upload ${wasm.length} bytes for "${contractName}"`);
    return 'DRY_RUN_WASM_HASH';
  }

  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase,
  })
    .addOperation(
      Operation.uploadContractWasm({
        wasm,
      })
    )
    .setTimeout(180)
    .build();

  const result = await submitTransaction({
    server,
    tx,
    keypair,
    networkPassphrase,
    dryRun,
    label: `upload WASM for "${contractName}"`,
  });

  const wasmHash = result.returnValue
    ? Buffer.from(scValToNative(result.returnValue)).toString('hex')
    : null;

  if (!wasmHash) {
    throw new Error(`Could not determine WASM hash for "${contractName}"`);
  }

  log.ok(`WASM hash for "${contractName}": ${wasmHash}`);
  return wasmHash;
}

// ---------------------------------------------------------------------------
// Contract deployment
// ---------------------------------------------------------------------------

async function deployContract({
  server,
  keypair,
  networkPassphrase,
  wasmHash,
  dryRun,
  contractName,
}) {
  log.step(`Deploying contract "${contractName}"`);

  if (dryRun) {
    log.info(`[dry-run] Would deploy "${contractName}" from WASM hash ${wasmHash}`);
    return `DRY_RUN_${contractName.toUpperCase().replace(/-/g, '_')}_ID`;
  }

  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase,
  })
    .addOperation(
      Operation.createCustomContract({
        address: Address.fromString(keypair.publicKey()),
        wasmHash: Buffer.from(wasmHash, 'hex'),
      })
    )
    .setTimeout(180)
    .build();

  const result = await submitTransaction({
    server,
    tx,
    keypair,
    networkPassphrase,
    dryRun,
    label: `deploy "${contractName}"`,
  });

  const contractId = scValToNative(result.returnValue);
  if (!contractId || !StrKey.isValidContract(contractId)) {
    throw new Error(`Invalid contract ID returned for "${contractName}": ${contractId}`);
  }

  log.ok(`Deployed "${contractName}" at ${contractId}`);
  return contractId;
}

// ---------------------------------------------------------------------------
// Contract initialization
// ---------------------------------------------------------------------------

async function initContract({
  server,
  keypair,
  networkPassphrase,
  contractId,
  adminAddress,
  dryRun,
  contractName,
}) {
  log.step(`Initializing contract "${contractName}"`);

  if (dryRun) {
    log.info(`[dry-run] Would call init(${adminAddress}) on "${contractName}"`);
    return;
  }

  const contract = new Contract(contractId);
  const account = await server.getAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase,
  })
    .addOperation(contract.call('init', Address.fromString(adminAddress).toScVal()))
    .setTimeout(180)
    .build();

  await submitTransaction({
    server,
    tx,
    keypair,
    networkPassphrase,
    dryRun,
    label: `init "${contractName}"`,
  });

  log.ok(`Initialized "${contractName}" with admin ${adminAddress}`);
}

// ---------------------------------------------------------------------------
// On-chain verification
// ---------------------------------------------------------------------------

async function fetchOnChainWasmHash(server, contractId) {
  const ledgerEntries = await server.getContractData(
    contractId,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    rpc.Durability.Persistent
  );
  if (!ledgerEntries || !ledgerEntries.val) return null;

  const executable = ledgerEntries.val.value?.executable;
  const wasmHash = executable?.wasmHash ?? executable?.value?.();
  if (!wasmHash) return null;
  return Buffer.from(wasmHash).toString('hex');
}

async function verifyContract({ server, contractId, dryRun, contractName, expectedAdmin }) {
  log.step(`Verifying contract "${contractName}"`);

  if (dryRun) {
    log.info(`[dry-run] Would verify "${contractName}" at ${contractId}`);
    return;
  }

  const ledgerEntries = await server.getContractData(
    contractId,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    rpc.Durability.Persistent
  );

  if (!ledgerEntries || !ledgerEntries.val) {
    throw new Error(`Contract "${contractName}" (${contractId}) not found on-chain`);
  }

  log.ok(`Verified "${contractName}" exists on-chain at ${contractId}`);

  if (expectedAdmin) {
    // SDK 17 exposes XDR union values and struct fields as properties.
    const storage = ledgerEntries.val.value?.val?.value?.storage ?? [];
    const entry = storage.find(({ key }) => {
      const native = scValToNative(key);
      return (
        (typeof native === 'string' && native.toLowerCase() === 'admin') ||
        (Array.isArray(native) &&
          native.length === 1 &&
          String(native[0]).toLowerCase() === 'admin')
      );
    });
    if (!entry) {
      log.warn(`Admin storage key unavailable for "${contractName}"; only existence was verified.`);
      return;
    }
    const admin = scValToNative(entry.val);
    if (admin !== expectedAdmin) {
      throw new Error(
        `Contract "${contractName}" admin mismatch: expected ${expectedAdmin}, got ${admin}`
      );
    }
    log.ok(`Verified "${contractName}" admin is ${expectedAdmin}`);
  }
}

// ---------------------------------------------------------------------------
// Resume logic
// ---------------------------------------------------------------------------

function loadExistingContractIds(network, filePath = CONTRACT_IDS_FILE) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  if (network && !content.split('\n').includes(`# Network: ${network}`)) {
    throw new Error(
      'Existing contract IDs belong to a different or unknown network; move the file before deploying.'
    );
  }
  const existing = {};
  for (const line of content.split('\n')) {
    if (!line.startsWith(CONTRACT_ENV_PREFIX)) continue;
    const [envName, contractId] = line.trim().split('=');
    const contract = CONTRACTS.find((c) => contractEnvName(c.name) === envName);
    if (!contract || !StrKey.isValidContract(contractId))
      throw new Error(`Invalid saved contract reference: ${envName}`);
    existing[contract.name] = contractId;
  }
  return existing;
}

// ---------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------

function writeContractIds(contractIds, network, dryRun) {
  log.step('Writing contract IDs');

  const lines = [
    `# Generated by scripts/deploy-contracts.cjs on ${new Date().toISOString()}`,
    `# Network: ${network}`,
    '',
  ];

  for (const [name, id] of Object.entries(contractIds)) {
    const envName = contractEnvName(name);
    lines.push(`${envName}=${id}`);
  }

  const content = lines.join('\n') + '\n';

  if (dryRun) {
    log.info('[dry-run] Would write the following to contract-ids.env:');
    console.log(content);
    return;
  }

  fs.writeFileSync(CONTRACT_IDS_FILE, content, { encoding: 'utf8' });
  log.ok(`Wrote contract IDs to ${CONTRACT_IDS_FILE}`);
}

function writeDeploymentRecord(
  contractIds,
  network,
  adminAddress,
  deployer,
  txHashes,
  dryRun,
  hashes = {}
) {
  log.step('Writing deployment record');

  const contractRecords = {};
  for (const [name, id] of Object.entries(contractIds)) {
    contractRecords[name] = {
      contractId: id,
      artifactHash: hashes[name]?.artifactHash ?? null,
      onChainHash: hashes[name]?.onChainHash ?? null,
    };
  }

  const deploymentJson = {
    timestamp: new Date().toISOString(),
    network,
    deployer,
    adminAddress,
    contracts: contractIds,
    contractHashes: contractRecords,
    transactionHashes: txHashes,
    gitRef: process.env.GIT_REF || null,
  };

  const recordFile = path.join(ROOT_DIR, `deployment-record-${network}-${Date.now()}.json`);
  const content = JSON.stringify(deploymentJson, null, 2) + '\n';

  if (dryRun) {
    log.info('[dry-run] Would write the following deployment record:');
    console.log(content);
    return;
  }

  fs.writeFileSync(recordFile, content, { encoding: 'utf8' });
  log.ok(`Wrote deployment record to ${recordFile}`);
  return recordFile;
}

/**
 * Re-read a deployment record, fetch current on-chain executable hashes and
 * compare them to the recorded values. Returns { ok, mismatches }.
 */
async function verifyDeploymentRecord({ server, recordPath }) {
  log.step('Verifying deployment record against on-chain state');

  const resolved = path.resolve(recordPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Deployment record not found: ${resolved}`);
  }
  const record = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const recorded = record.contractHashes || {};
  const mismatches = [];

  for (const [name, id] of Object.entries(record.contracts || {})) {
    const expected = recorded[name]?.onChainHash || null;
    let actual = null;
    try {
      actual = await fetchOnChainWasmHash(server, id);
    } catch (err) {
      mismatches.push(`${name} (${id}): unable to fetch on-chain hash (${err.message})`);
      continue;
    }

    if (!expected) {
      log.warn(`${name} (${id}): no recorded on-chain hash to compare`);
      continue;
    }
    if (actual !== expected) {
      mismatches.push(`${name} (${id}): recorded ${expected}, on-chain ${actual || 'unknown'}`);
    } else {
      log.ok(`${name} (${id}): on-chain hash matches record (${actual})`);
    }
  }

  if (mismatches.length > 0) {
    log.error('Deployment record verification failed:');
    for (const m of mismatches) log.error(`  - ${m}`);
    return { ok: false, mismatches };
  }

  log.ok('All recorded hashes agree with deployed contracts');
  return { ok: true, mismatches };
}

// ---------------------------------------------------------------------------
// Read-only planning mode
// ---------------------------------------------------------------------------

function maskSecret(value) {
  if (!value) return '<unset>';
  return `${value.slice(0, 4)}…${value.slice(-4)} (masked)`;
}

/**
 * Report the resolved network, artifact hashes, signer public key and planned
 * contract operations without signing or submitting anything. Never prints
 * secret material.
 */
function planDeployment({ network, rpcUrl, contracts, keypair, adminAddress, manifest, existingIds = {} }) {
  log.step('Deployment plan (read-only)');

  const artifactHashes = {};
  for (const contract of contracts) {
    artifactHashes[contract.name] = fs.existsSync(contract.wasm)
      ? hashWasmFile(contract.wasm)
      : '<missing>';
  }

  const plan = {
    network,
    rpcUrl,
    signerPublicKey: keypair.publicKey(),
    secretKey: maskSecret(process.env.STELLAR_SECRET_KEY),
    adminAddress,
    manifest: manifest ? manifest.path : null,
    artifacts: contracts.map((c) => ({
      name: c.name,
      wasm: c.wasm,
      artifactHash: artifactHashes[c.name],
      action: existingIds[c.name] ? 'skip (already deployed)' : 'upload + deploy + init',
      existingContractId: existingIds[c.name] || null,
    })),
    plannedOperations: contracts
      .filter((c) => !existingIds[c.name])
      .flatMap((c) => [
        `uploadContractWasm(${c.wasmFile})`,
        `createCustomContract(${c.name})`,
        `init(${adminAddress}) on ${c.name}`,
      ]),
  };

  console.log(JSON.stringify(plan, null, 2));
  log.warn('Plan mode: no transactions were signed or submitted.');
  return plan;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { keypair, network, rpcUrl, adminAddress, contracts } = validateEnv(args);
  const networkPassphrase = NETWORK_PASSPHRASES[network];

  log.info(`Target network: ${network}`);
  log.info(`Soroban RPC URL: ${rpcUrl}`);
  if (args.dryRun) {
    log.warn('Running in DRY-RUN mode');
  }

  const manifest = loadManifest(args.manifest);
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

  // Read-only record verification: no signing or submission.
  if (args.verifyRecord) {
    const { ok } = await verifyDeploymentRecord({ server, recordPath: args.verifyRecord });
    if (!ok) process.exit(1);
    return;
  }

  // Read-only planning mode: never signs or submits.
  if (args.plan) {
    validateManifest(manifest, contracts);
    const existingIds = loadExistingContractIds(network);
    planDeployment({ network, rpcUrl, contracts, keypair, adminAddress, manifest, existingIds });
    return;
  }

  const confirmed = await confirmMainnet(network, args.yes);
  if (!confirmed) {
    log.error('Mainnet deployment not confirmed. Aborting.');
    process.exit(1);
  }

  // Concurrency guard: acquire before any signing/submission.
  const lockFile = args.dryRun ? null : acquireLock(network, keypair.publicKey());

  try {
    await runDeployment({ args, server, keypair, network, networkPassphrase, adminAddress, contracts, manifest });
  } finally {
    releaseLock(lockFile);
  }
}

async function runDeployment({
  args,
  server,
  keypair,
  network,
  networkPassphrase,
  adminAddress,
  contracts,
  manifest,
}) {
  await preflightChecks({ server, keypair, network, contracts, dryRun: args.dryRun, manifest });

  log.info(`Admin address for init(): ${adminAddress}`);

  // Load existing contract IDs (for resume support)
  const existingIds = loadExistingContractIds(network);
  for (const [contractName, contractId] of Object.entries(existingIds)) {
    await verifyContract({ server, contractId, contractName, dryRun: false });
  }
  const contractIds = { ...existingIds };
  const hashes = {};

  const contractsToDeploy = contracts.filter((c) => !existingIds[c.name]);

  if (contractsToDeploy.length < contracts.length) {
    log.step(`Resuming: ${contractsToDeploy.length}/${contracts.length} contracts need deployment`);
    for (const name of Object.keys(existingIds)) {
      log.info(`Skipping ${name} (already deployed at ${existingIds[name]})`);
    }
  }

  for (const contract of contractsToDeploy) {
    const artifactHash = hashWasmFile(contract.wasm);
    const wasmHash = await uploadWasm({
      server,
      keypair,
      networkPassphrase,
      wasmPath: contract.wasm,
      dryRun: args.dryRun,
      contractName: contract.name,
    });

    const contractId = await deployContract({
      server,
      keypair,
      networkPassphrase,
      wasmHash,
      dryRun: args.dryRun,
      contractName: contract.name,
    });

    await initContract({
      server,
      keypair,
      networkPassphrase,
      contractId,
      adminAddress,
      dryRun: args.dryRun,
      contractName: contract.name,
    });

    await verifyContract({
      server,
      contractId,
      dryRun: args.dryRun,
      contractName: contract.name,
      expectedAdmin: adminAddress,
    });

    let onChainHash = null;
    if (!args.dryRun) {
      onChainHash = await fetchOnChainWasmHash(server, contractId);
      if (onChainHash && onChainHash !== artifactHash) {
        log.warn(
          `On-chain executable hash for "${contract.name}" (${onChainHash}) differs from local artifact (${artifactHash})`
        );
      }
    }

    hashes[contract.name] = { artifactHash, onChainHash };
    contractIds[contract.name] = contractId;
  }

  writeContractIds(contractIds, network, args.dryRun);
  writeDeploymentRecord(
    contractIds,
    network,
    adminAddress,
    keypair.publicKey(),
    {},
    args.dryRun,
    hashes
  );

  log.step('Deployment complete');
  for (const [name, id] of Object.entries(contractIds)) {
    log.ok(`${name}: ${id}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    log.error(err.message || String(err));
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  validateEnv,
  CONTRACTS,
  contractEnvName,
  loadManifest,
  hashWasmFile,
  validateManifest,
  acquireLock,
  releaseLock,
  lockFilePath,
  preflightChecks,
  submitTransaction,
  pollTransaction,
  uploadWasm,
  deployContract,
  initContract,
  verifyContract,
  fetchOnChainWasmHash,
  loadExistingContractIds,
  writeContractIds,
  writeDeploymentRecord,
  verifyDeploymentRecord,
  planDeployment,
};
