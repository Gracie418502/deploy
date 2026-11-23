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

// Default TTL thresholds, expressed in ledgers. Soroban ledgers close roughly
// every 5 seconds, so 1000 ledgers is a little under 1.5 hours.
const DEFAULT_MIN_INSTANCE_TTL_LEDGERS = 1000;
const DEFAULT_MIN_CODE_TTL_LEDGERS = 1000;

// Hard floor below which a deployment is considered failed. When remaining TTL
// drops under this value the script exits non-zero (unless --ttl-fail-mode=warn).
const DEFAULT_TTL_HARD_FLOOR_LEDGERS = 100;

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

// Default fee ceilings (in stroops). 1 XLM = 10,000,000 stroops.
const DEFAULT_MAX_FEE_STROOPS = 10_000_000n; // 1 XLM per transaction
const DEFAULT_MAX_TOTAL_FEE_STROOPS = 100_000_000n; // 10 XLM across all transactions

// Default overall deadline for a single transaction confirmation.
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parsePositiveInt(value, flagName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flagName} requires a non-negative integer (got: ${value})`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    network: null,
    dryRun: false,
    yes: false,
    wasmDir: null,
    minInstanceTtl: null,
    minCodeTtl: null,
    ttlFailMode: null,
    maxFee: null,
    maxTotalFee: null,
    confirmTimeoutMs: null,
    plan: false,
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
    } else if (arg === '--min-instance-ttl') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--min-instance-ttl requires a value');
      }
      args.minInstanceTtl = parsePositiveInt(value, '--min-instance-ttl');
    } else if (arg.startsWith('--min-instance-ttl=')) {
      args.minInstanceTtl = parsePositiveInt(
        arg.slice('--min-instance-ttl='.length),
        '--min-instance-ttl'
      );
    } else if (arg === '--min-code-ttl') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--min-code-ttl requires a value');
      }
      args.minCodeTtl = parsePositiveInt(value, '--min-code-ttl');
    } else if (arg.startsWith('--min-code-ttl=')) {
      args.minCodeTtl = parsePositiveInt(arg.slice('--min-code-ttl='.length), '--min-code-ttl');
    } else if (arg === '--ttl-fail-mode') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--ttl-fail-mode requires a value (warn|fail)');
      }
      args.ttlFailMode = value;
    } else if (arg.startsWith('--ttl-fail-mode=')) {
      args.ttlFailMode = arg.slice('--ttl-fail-mode='.length);
    } else if (arg === '--max-fee') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--max-fee requires a value (in stroops)');
      }
      args.maxFee = value;
    } else if (arg.startsWith('--max-fee=')) {
      args.maxFee = arg.slice('--max-fee='.length);
    } else if (arg === '--max-total-fee') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--max-total-fee requires a value (in stroops)');
      }
      args.maxTotalFee = value;
    } else if (arg.startsWith('--max-total-fee=')) {
      args.maxTotalFee = arg.slice('--max-total-fee='.length);
    } else if (arg === '--confirm-timeout') {
      const value = argv[++i];
      if (!value) {
        throw new Error('--confirm-timeout requires a value (in milliseconds)');
      }
      args.confirmTimeoutMs = value;
    } else if (arg.startsWith('--confirm-timeout=')) {
      args.confirmTimeoutMs = arg.slice('--confirm-timeout='.length);
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

  if (args.ttlFailMode && !['warn', 'fail'].includes(args.ttlFailMode)) {
    throw new Error(`Invalid --ttl-fail-mode value: ${args.ttlFailMode} (expected warn|fail)`);
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
  --min-instance-ttl <ledgers>           Warn when a contract instance's remaining TTL is below this
                                         value (defaults to $MIN_INSTANCE_TTL_LEDGERS, then ${DEFAULT_MIN_INSTANCE_TTL_LEDGERS}).
  --min-code-ttl <ledgers>               Warn when a contract's code entry remaining TTL is below this
                                         value (defaults to $MIN_CODE_TTL_LEDGERS, then ${DEFAULT_MIN_CODE_TTL_LEDGERS}).
  --ttl-fail-mode <warn|fail>            Behavior when remaining TTL drops below the hard floor
                                         (${DEFAULT_TTL_HARD_FLOOR_LEDGERS} ledgers). Defaults to "fail".
  --max-fee <stroops>                    Maximum fee (in stroops) allowed for any single
                                         transaction (defaults to $MAX_FEE, then 10000000).
  --max-total-fee <stroops>              Maximum cumulative fee (in stroops) allowed across
                                         all transactions (defaults to $MAX_TOTAL_FEE, then 100000000).
  --confirm-timeout <ms>                 Overall deadline for each transaction confirmation
                                         (defaults to $CONFIRM_TIMEOUT_MS, then 120000).
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

  const minInstanceTtl =
    args.minInstanceTtl ??
    (process.env.MIN_INSTANCE_TTL_LEDGERS !== undefined
      ? parsePositiveInt(process.env.MIN_INSTANCE_TTL_LEDGERS, 'MIN_INSTANCE_TTL_LEDGERS')
      : DEFAULT_MIN_INSTANCE_TTL_LEDGERS);
  const minCodeTtl =
    args.minCodeTtl ??
    (process.env.MIN_CODE_TTL_LEDGERS !== undefined
      ? parsePositiveInt(process.env.MIN_CODE_TTL_LEDGERS, 'MIN_CODE_TTL_LEDGERS')
      : DEFAULT_MIN_CODE_TTL_LEDGERS);
  const ttlFailMode = args.ttlFailMode || 'fail';
  const maxFee = parseStroopLimit(
    args.maxFee ?? process.env.MAX_FEE,
    DEFAULT_MAX_FEE_STROOPS,
    'MAX_FEE'
  );
  const maxTotalFee = parseStroopLimit(
    args.maxTotalFee ?? process.env.MAX_TOTAL_FEE,
    DEFAULT_MAX_TOTAL_FEE_STROOPS,
    'MAX_TOTAL_FEE'
  );
  const confirmTimeoutMs = parsePositiveInt(
    args.confirmTimeoutMs ?? process.env.CONFIRM_TIMEOUT_MS,
    DEFAULT_CONFIRM_TIMEOUT_MS,
    'CONFIRM_TIMEOUT_MS'
  );

  return {
    keypair,
    network,
    rpcUrl,
    adminAddress,
    contracts,
    minInstanceTtl,
    minCodeTtl,
    ttlFailMode,
    maxFee,
    maxTotalFee,
    confirmTimeoutMs,
  };
}

function parseStroopLimit(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer number of stroops, got: ${raw}`);
  }
  return BigInt(value);
}

function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = String(raw).trim();
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds, got: ${raw}`);
  }
  return Number(value);
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
// Network identity verification
// ---------------------------------------------------------------------------

/**
 * Compare the RPC-reported network identity with the selected network's
 * passphrase. Fails fast (before any signing/submission) on mismatch.
 */
async function verifyNetworkIdentity({ server, network, networkPassphrase }) {
  log.step('Verifying RPC network identity');

  const expected = networkPassphrase || NETWORK_PASSPHRASES[network];
  if (!expected) {
    throw new Error(`No network passphrase configured for "${network}"`);
  }

  let reported = null;
  if (typeof server.getNetwork === 'function') {
    try {
      const info = await server.getNetwork();
      reported = info && (info.passphrase || info.networkPassphrase || null);
    } catch (err) {
      throw new Error(`Unable to query RPC network identity: ${err.message}`);
    }
  } else if (typeof server.getNetworkPassphrase === 'function') {
    try {
      reported = await server.getNetworkPassphrase();
    } catch (err) {
      throw new Error(`Unable to query RPC network identity: ${err.message}`);
    }
  }

  if (!reported) {
    throw new Error(
      'RPC endpoint did not report a network passphrase; refusing to sign transactions against an unverified endpoint.'
    );
  }

  if (reported !== expected) {
    throw new Error(
      `RPC network identity mismatch: endpoint reports "${reported}" but "${network}" expects "${expected}". ` +
        'Refusing to sign or submit transactions against a mismatched endpoint.'
    );
  }

  log.ok(`RPC network identity matches "${network}"`);
  return reported;
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

/**
 * Enforce the per-transaction and cumulative fee ceilings against the fee
 * estimated by simulation (via prepareTransaction). Aborts before signing.
 */
function enforceFeeCeiling({ label, estimatedFee, maxFee, maxTotalFee, spentFee }) {
  const fee = BigInt(estimatedFee);
  const total = BigInt(spentFee) + fee;

  if (maxFee !== null && maxFee !== undefined && fee > BigInt(maxFee)) {
    throw new Error(
      `Estimated fee for ${label} (${fee} stroops) exceeds the per-transaction ceiling ` +
        `(--max-fee / MAX_FEE = ${maxFee} stroops). Aborting before signing.`
    );
  }

  if (maxTotalFee !== null && maxTotalFee !== undefined && total > BigInt(maxTotalFee)) {
    throw new Error(
      `Estimated cumulative fee after ${label} (${total} stroops) exceeds the total ceiling ` +
        `(--max-total-fee / MAX_TOTAL_FEE = ${maxTotalFee} stroops). Aborting before signing.`
    );
  }

  return total;
}

async function submitTransaction({
  server,
  tx,
  keypair,
  dryRun,
  label,
  maxFee,
  maxTotalFee,
  feeTracker,
  confirmTimeoutMs,
}) {
  if (dryRun) {
    log.info(`[dry-run] Skipping submission: ${label}`);
    return null;
  }

  const prepared = await server.prepareTransaction(tx);

  // Estimate the fee from the simulated/prepared transaction before signing.
  const estimatedFee = BigInt(prepared.fee);
  const spentFee = feeTracker ? feeTracker.spent : 0n;
  const newTotal = enforceFeeCeiling({
    label,
    estimatedFee,
    maxFee,
    maxTotalFee,
    spentFee,
  });
  log.info(`Estimated fee for ${label}: ${estimatedFee} stroops`);

  prepared.sign(keypair);

  const sendResponse = await server.sendTransaction(prepared);
  if (sendResponse.status === 'ERROR') {
    throw new Error(
      `Transaction submission failed for ${label}: ${JSON.stringify(sendResponse.errorResult || sendResponse)}`
    );
  }

  const hash = sendResponse.hash;
  if (feeTracker) {
    feeTracker.spent = newTotal;
  }
  log.info(`Submitted ${label} (hash: ${hash}); awaiting confirmation...`);

  const result = await pollTransaction(server, hash, { timeoutMs: confirmTimeoutMs });
  if (result.status !== 'SUCCESS') {
    throw new Error(`Transaction ${hash} for ${label} did not succeed: ${result.status}`);
  }

  log.ok(`Confirmed ${label} (hash: ${hash})`);
  return result;
}

/**
 * Poll for a transaction result until it is no longer NOT_FOUND or the overall
 * deadline elapses. On timeout the error includes the hash and last status so
 * operators can reconcile the transaction later.
 */
async function pollTransaction(
  server,
  hash,
  { timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS, intervalMs = 2000 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'NOT_FOUND';

  while (true) {
    const response = await server.getTransaction(hash);
    lastStatus = response.status;
    if (response.status !== 'NOT_FOUND') {
      return response;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for transaction ${hash} ` +
      `(last observed status: ${lastStatus}). ` +
      'The transaction may still be pending; reconcile using this hash before retrying.'
  );
}

// ---------------------------------------------------------------------------
// WASM upload
// ---------------------------------------------------------------------------

async function uploadWasm({
  server,
  keypair,
  networkPassphrase,
  wasmPath,
  dryRun,
  contractName,
  maxFee,
  maxTotalFee,
  feeTracker,
  confirmTimeoutMs,
}) {
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
    maxFee,
    maxTotalFee,
    feeTracker,
    confirmTimeoutMs,
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
  maxFee,
  maxTotalFee,
  feeTracker,
  confirmTimeoutMs,
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
    maxFee,
    maxTotalFee,
    feeTracker,
    confirmTimeoutMs,
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
  maxFee,
  maxTotalFee,
  feeTracker,
  confirmTimeoutMs,
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
    maxFee,
    maxTotalFee,
    feeTracker,
    confirmTimeoutMs,
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
// TTL inspection
// ---------------------------------------------------------------------------

function readLiveUntilLedgerSeq(entry) {
  if (!entry) return null;
  const raw =
    typeof entry.liveUntilLedgerSeq === 'function'
      ? entry.liveUntilLedgerSeq()
      : entry.liveUntilLedgerSeq;
  if (raw === undefined || raw === null) return null;
  return Number(raw.toString());
}

async function fetchTtlForEntry({ server, key, durability, label }) {
  let entry;
  try {
    entry = await server.getContractData(key, durability);
  } catch (err) {
    log.warn(`Unable to read ${label} ledger entry: ${err.message}`);
    return null;
  }
  if (!entry) {
    log.warn(`No ${label} ledger entry found`);
    return null;
  }
  const liveUntilLedgerSeq = readLiveUntilLedgerSeq(entry);
  if (liveUntilLedgerSeq === null) {
    log.warn(`No liveUntilLedgerSeq reported for ${label} ledger entry`);
    return null;
  }
  return liveUntilLedgerSeq;
}

/**
 * Inspect the remaining TTL of a deployed contract's instance and code entries.
 *
 * Returns an object describing the observed ledger values and whether the
 * configured minimums were met:
 *   {
 *     contractName, contractId, currentLedger,
 *     instance: { liveUntilLedger, remainingTtl, minTtl, belowMinimum },
 *     code:     { liveUntilLedger, remainingTtl, minTtl, belowMinimum },
 *     belowHardFloor: boolean,
 *   }
 */
async function inspectContractTtl({
  server,
  contractId,
  contractName,
  wasmHash,
  minInstanceTtl = DEFAULT_MIN_INSTANCE_TTL_LEDGERS,
  minCodeTtl = DEFAULT_MIN_CODE_TTL_LEDGERS,
  hardFloor = DEFAULT_TTL_HARD_FLOOR_LEDGERS,
  dryRun = false,
}) {
  log.step(`Inspecting TTL for "${contractName}"`);

  if (dryRun) {
    log.info(`[dry-run] Would inspect TTL for "${contractName}" at ${contractId}`);
    return null;
  }

  const latest = await server.getLatestLedger();
  const currentLedger = Number(latest.sequence);
  log.info(`Current ledger: ${currentLedger}`);

  const instanceLiveUntil = await fetchTtlForEntry({
    server,
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: rpc.Durability.Persistent,
    label: `"${contractName}" instance`,
  });

  let codeLiveUntil = null;
  if (wasmHash) {
    codeLiveUntil = await fetchTtlForEntry({
      server,
      key: xdr.ScVal.scvLedgerKeyContractCode(Buffer.from(wasmHash, 'hex')),
      durability: rpc.Durability.Persistent,
      label: `"${contractName}" code`,
    });
  } else {
    log.warn(`No WASM hash available for "${contractName}"; skipping code TTL inspection`);
  }

  const summarize = (liveUntilLedger, minTtl, label) => {
    if (liveUntilLedger === null) {
      return { liveUntilLedger: null, remainingTtl: null, minTtl, belowMinimum: null };
    }
    const remainingTtl = liveUntilLedger - currentLedger;
    const belowMinimum = remainingTtl < minTtl;
    log.info(
      `${label}: liveUntilLedger=${liveUntilLedger}, remainingTtl=${remainingTtl} ledgers ` +
        `(minimum ${minTtl})`
    );
    if (belowMinimum) {
      log.warn(
        `${label} remaining TTL (${remainingTtl} ledgers) is below the configured minimum (${minTtl} ledgers).`
      );
    } else {
      log.ok(`${label} remaining TTL is above the configured minimum`);
    }
    return { liveUntilLedger, remainingTtl, minTtl, belowMinimum };
  };

  const instance = summarize(instanceLiveUntil, minInstanceTtl, `"${contractName}" instance TTL`);
  const code = summarize(codeLiveUntil, minCodeTtl, `"${contractName}" code TTL`);

  const belowHardFloor =
    (instance.remainingTtl !== null && instance.remainingTtl < hardFloor) ||
    (code.remainingTtl !== null && code.remainingTtl < hardFloor);

  if (belowHardFloor) {
    log.warn(
      `"${contractName}" remaining TTL is below the hard floor of ${hardFloor} ledgers. ` +
        'Extend the contract TTL (e.g. via `stellar contract extend` or a bump-footprint operation).'
    );
  }

  return {
    contractName,
    contractId,
    currentLedger,
    instance,
    code,
    belowHardFloor,
  };
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
  hashes = {},
  ttlObservations = {}
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
    ttl: ttlObservations,
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

  const {
    keypair,
    network,
    rpcUrl,
    adminAddress,
    contracts,
    minInstanceTtl,
    minCodeTtl,
    ttlFailMode,
    maxFee,
    maxTotalFee,
    confirmTimeoutMs,
  } = validateEnv(args);
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

  await verifyNetworkIdentity({ server, network, networkPassphrase });

  await preflightChecks({ server, keypair, network, contracts, dryRun: args.dryRun });
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

  log.info(`Per-transaction fee ceiling: ${maxFee} stroops`);
  log.info(`Total fee ceiling: ${maxTotalFee} stroops`);
  log.info(`Confirmation deadline: ${confirmTimeoutMs}ms`);

  const feeTracker = { spent: 0n };

  log.info(`Admin address for init(): ${adminAddress}`);

  // Load existing contract IDs (for resume support)
  const existingIds = loadExistingContractIds(network);
  for (const [contractName, contractId] of Object.entries(existingIds)) {
    await verifyContract({ server, contractId, contractName, dryRun: false });
  }
  const contractIds = { ...existingIds };
  const hashes = {};

  // TTL observations keyed by contract name, recorded in the deployment record.
  const ttlObservations = {};
  const wasmHashes = {};
  let ttlHardFloorBreached = false;

  const recordTtl = async (contractName, contractId, wasmHash) => {
    const observation = await inspectContractTtl({
      server,
      contractId,
      contractName,
      wasmHash,
      minInstanceTtl,
      minCodeTtl,
      dryRun: args.dryRun,
    });
    if (observation) {
      ttlObservations[contractName] = observation;
      if (observation.belowHardFloor) {
        ttlHardFloorBreached = true;
      }
    }
  };

  // Inspect TTL for resumed contracts too.
  for (const [contractName, contractId] of Object.entries(existingIds)) {
    await recordTtl(contractName, contractId, wasmHashes[contractName]);
  }

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
      maxFee,
      maxTotalFee,
      feeTracker,
      confirmTimeoutMs,
    });
    wasmHashes[contract.name] = wasmHash;

    const contractId = await deployContract({
      server,
      keypair,
      networkPassphrase,
      wasmHash,
      dryRun: args.dryRun,
      contractName: contract.name,
      maxFee,
      maxTotalFee,
      feeTracker,
      confirmTimeoutMs,
    });

    await initContract({
      server,
      keypair,
      networkPassphrase,
      contractId,
      adminAddress,
      dryRun: args.dryRun,
      contractName: contract.name,
      maxFee,
      maxTotalFee,
      feeTracker,
      confirmTimeoutMs,
    });

    await verifyContract({
      server,
      contractId,
      dryRun: args.dryRun,
      contractName: contract.name,
      expectedAdmin: adminAddress,
    });

    await recordTtl(contract.name, contractId, wasmHash);

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
    ttlObservations,
    hashes
  );

  log.step('Deployment complete');
  for (const [name, id] of Object.entries(contractIds)) {
    log.ok(`${name}: ${id}`);
  }

  if (ttlHardFloorBreached) {
    const message =
      `One or more contracts have remaining TTL below the hard floor of ` +
      `${DEFAULT_TTL_HARD_FLOOR_LEDGERS} ledgers. Extend the contract TTL before relying on it.`;
    if (ttlFailMode === 'fail') {
      throw new Error(message);
    }
    log.warn(message);
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
  verifyNetworkIdentity,
  loadManifest,
  hashWasmFile,
  validateManifest,
  acquireLock,
  releaseLock,
  lockFilePath,
  preflightChecks,
  enforceFeeCeiling,
  submitTransaction,
  pollTransaction,
  uploadWasm,
  deployContract,
  initContract,
  verifyContract,
  inspectContractTtl,
  fetchOnChainWasmHash,
  loadExistingContractIds,
  writeContractIds,
  writeDeploymentRecord,
  DEFAULT_MAX_FEE_STROOPS,
  DEFAULT_MAX_TOTAL_FEE_STROOPS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  verifyDeploymentRecord,
  planDeployment,
};
