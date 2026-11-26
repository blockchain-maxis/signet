#!/usr/bin/env node
/**
 * Identity Registry storage keep-alive & archival report.
 *
 * Soroban persistent entries expire when their TTL lapses: handle bindings
 * (`DataKey::Owner(handle)`, `DataKey::Handle(wallet)`) and the contract
 * instance (`Admin` + `Count`), which is the entry whose archival makes *every*
 * entry point — `claim` included — fail. The contract bumps those TTLs whenever
 * it is **invoked**, but a simulated read discards its footprint and extends
 * nothing (see `IdentityRegistry::bump_instance` and docs/DEPLOYMENT.md §11),
 * so a registry whose traffic is all view-simulations still needs a real
 * transaction to stay alive.
 *
 * This script builds a read-only footprint from the instance key and, for each
 * handle, `DataKey::Owner(handle)` plus (once the owner is known)
 * `DataKey::Handle(wallet)`, then:
 *
 *   - with `KEEPALIVE_SECRET`: simulates the footprint for resources, signs an
 *     `ExtendFootprintTTL` operation over the entries that actually exist,
 *     submits it and waits for the result. Entries are only reported as
 *     extended when their key is in the submitted footprint;
 *   - without it: reports only — each live entry's `liveUntilLedgerSeq` and
 *     ledgers remaining, handles that are unbound, and entries that need
 *     restoring. Nothing is submitted and nothing is called "bumped".
 *
 * Usage:
 *   node scripts/keepalive-contract.mjs --instance-only
 *   node scripts/keepalive-contract.mjs <handle1> [handle2] ...
 *   KEEPALIVE_SECRET=S... node scripts/keepalive-contract.mjs <handle1> ...
 *
 * Env:
 *   SOROBAN_RPC_URL                    Soroban RPC endpoint (default: testnet)
 *   REGISTRY_CONTRACT_ID               Identity Registry contract id
 *   NEXT_PUBLIC_IDENTITY_REGISTRY_ID   (fallback for the above)
 *   KEEPALIVE_SECRET                   Funded S... key that signs the extension.
 *                                      Unset = report mode.
 *
 * The contract id has no default on purpose: the testnet native XLM SAC
 * (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`) used to be the
 * fallback here, and resolving against the SAC fails for every handle.
 *
 * Exit status: 1 when an entry is archived (restore it first — see
 * docs/DEPLOYMENT.md §11), when a submission fails, or when usage is wrong.
 */

import { pathToFileURL } from 'node:url';

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

/** ~30 days at ~5s per ledger: the window the contract's own bumps use. */
export const EXTEND_TO_LEDGERS = 518_400;

export const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

/** Keys per `getLedgerEntries` call; the RPC caps the request size. */
const READ_BATCH = 100;

/** A valid-but-unfunded source is enough to simulate: simulation needs no balance. */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const POLL_ATTEMPTS = 30;

export const USAGE = `Usage:
  node scripts/keepalive-contract.mjs --instance-only
  node scripts/keepalive-contract.mjs <handle1> [handle2] ...

Extends the registry instance and each handle's binding TTL with a real
ExtendFootprintTTL transaction when KEEPALIVE_SECRET is set; otherwise reports
each entry's remaining ledgers without submitting anything.

Env:
  SOROBAN_RPC_URL                    Soroban RPC endpoint (default: ${DEFAULT_RPC_URL})
  REGISTRY_CONTRACT_ID               Identity Registry contract id (or
  NEXT_PUBLIC_IDENTITY_REGISTRY_ID   NEXT_PUBLIC_IDENTITY_REGISTRY_ID)
  KEEPALIVE_SECRET                   Funded S... key that signs the extension`;

export class UsageError extends Error {}

/**
 * A `DataKey::Owner(handle)` ScVal.
 *
 * `DataKey` in packages/contracts/identity-registry/src/lib.rs is a plain
 * `#[contracttype]` enum, and Soroban keys a tuple variant by *name*, not by
 * position: `ScVec[Symbol("Owner"), String(handle)]`. Numeric U32 variants are
 * the encoding for a `#[repr(u32)]`-style enum and match no stored key, so a
 * wrong guess here reads nothing and extends nothing (see
 * apps/web/e2e/fixtures/contracts.ts, whose OWNER_KEY is this exact shape).
 */
export function ownerKeyScVal(handle) {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Owner'),
    nativeToScVal(handle, { type: 'string' }),
  ]);
}

/** A `DataKey::Handle(wallet)` ScVal: `ScVec[Symbol("Handle"), Address(wallet)]`. */
export function handleKeyScVal(wallet) {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Handle'), new Address(wallet).toScVal()]);
}

/** A persistent `ContractData` ledger key for `keyScVal` in the registry. */
export function contractDataLedgerKey(contractId, keyScVal) {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(contractId).address().toScAddress(),
      key: keyScVal,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** The registry instance entry — `Admin`, `Count` and the wasm hash. */
export function instanceLedgerKey(contractId) {
  return contractDataLedgerKey(contractId, xdr.ScVal.scvLedgerKeyContractInstance());
}

/** Parse `--instance-only`, `--help` and the handle list. */
export function parseArgs(argv) {
  const handles = [];
  let instanceOnly = false;

  for (const arg of argv) {
    if (arg === '--instance-only') {
      instanceOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, handles: [], instanceOnly: false };
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else if (!handles.includes(arg)) {
      handles.push(arg);
    }
  }

  if (instanceOnly && handles.length > 0) {
    throw new UsageError('--instance-only takes no handles.');
  }
  if (!instanceOnly && handles.length === 0) {
    throw new UsageError('Pass at least one handle, or --instance-only.');
  }

  return { help: false, handles, instanceOnly };
}

function keyId(ledgerKey) {
  return ledgerKey.toXDR('base64');
}

function entryWallet(entry) {
  const data = entry?.val?.contractData?.();
  if (!data) return null;
  const val = data.val();
  if (!val || val.switch().name !== 'scvAddress') return null;
  return Address.fromScVal(val).toString();
}

/** A simulation returns a `SorobanDataBuilder`; a stub may hand back SorobanData. */
function sorobanDataOf(value) {
  return typeof value?.build === 'function' ? value.build() : value;
}

function xdrBase64(value) {
  if (!value) return '(none)';
  try {
    return xdr.TransactionResult.fromXDR(value, 'base64').result().switch().name;
  } catch {
    return String(value);
  }
}

/**
 * Sweep (or report on) the registry's storage entries.
 *
 * `server` is injectable so the tests can drive a stub `rpc.Server`; every
 * other dependency (clock, streams) is injectable for the same reason.
 */
export async function runSweep({
  handles = [],
  instanceOnly = false,
  contractId,
  rpcUrl = DEFAULT_RPC_URL,
  secret,
  server,
  log = console.log,
  warn = console.warn,
  errorLog = console.error,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollAttempts = POLL_ATTEMPTS,
} = {}) {
  if (!contractId) throw new UsageError('The Identity Registry contract id is not set.');

  const rpcServer = server ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const keypair = secret ? Keypair.fromSecret(secret) : null;

  const { passphrase } = await rpcServer.getNetwork();

  const contract = new Contract(contractId);
  const targets = [{ label: 'instance', role: 'instance', key: instanceLedgerKey(contractId) }];
  for (const handle of instanceOnly ? [] : handles) {
    targets.push({
      label: `owner:${handle}`,
      role: 'owner',
      handle,
      key: contractDataLedgerKey(contractId, ownerKeyScVal(handle)),
    });
  }

  log('Signet Identity Registry keep-alive');
  log(`  RPC:      ${rpcUrl}`);
  log(`  Registry: ${contractId}`);
  log(
    `  Mode:     ${keypair ? 'extend (KEEPALIVE_SECRET set)' : 'report (set KEEPALIVE_SECRET to extend)'}`,
  );
  log(`  Targets:  ${targets.map((t) => t.label).join(', ')}`);
  log('');

  const live = new Map();
  let latestLedger = 0;

  async function readTargets(list) {
    for (let i = 0; i < list.length; i += READ_BATCH) {
      const keys = list.slice(i, i + READ_BATCH).map((t) => t.key);
      const res = await rpcServer.getLedgerEntries(...keys);
      if (!res || !Array.isArray(res.entries)) {
        throw new Error('getLedgerEntries returned no entries array');
      }
      latestLedger = Math.max(latestLedger, Number(res.latestLedger) || 0);
      for (const entry of res.entries) live.set(keyId(entry.key), entry);
    }
  }

  await readTargets(targets);

  // A bound handle owns two entries; the wallet is only known once the Owner
  // entry has been read, so the reverse keys need a second pass.
  const walletTargets = [];
  for (const target of [...targets]) {
    if (target.role !== 'owner') continue;
    const wallet = entryWallet(live.get(keyId(target.key)));
    if (!wallet) continue;
    target.wallet = wallet;
    walletTargets.push({
      label: `handle:${wallet}`,
      role: 'wallet',
      wallet,
      key: contractDataLedgerKey(contractId, handleKeyScVal(wallet)),
    });
  }
  targets.push(...walletTargets);
  if (walletTargets.length > 0) await readTargets(walletTargets);

  if (!latestLedger) {
    latestLedger = Number((await rpcServer.getLatestLedger()).sequence) || 0;
  }

  const reportLive = (prefix) => {
    for (const target of targets) {
      const entry = live.get(keyId(target.key));
      if (!entry) continue;
      const liveUntil = Number(entry.liveUntilLedgerSeq);
      log(
        `${prefix} ${target.label}: ${liveUntil - latestLedger} ledgers remaining (live until ledger ${liveUntil})`,
      );
    }
  };
  reportLive('[LIVE]  ');

  const footprintKeys = targets.map((t) => t.key);
  const simulation = await rpcServer.simulateTransaction(
    buildExtendTransaction({
      passphrase,
      source: new Account(SIMULATION_SOURCE, '0'),
      footprint: footprintKeys,
    }),
  );

  if (rpc.Api.isSimulationError(simulation)) {
    errorLog(`[FAIL]  footprint simulation failed: ${simulation.error}`);
    return { exitCode: 1, live: 0, unbound: 0, archived: targets.length };
  }

  const archivedKeys = new Set();
  if (rpc.Api.isSimulationRestore(simulation)) {
    const footprint = sorobanDataOf(simulation.restorePreamble.transactionData)
      .resources()
      .footprint();
    for (const key of [...footprint.readOnly(), ...footprint.readWrite()]) {
      archivedKeys.add(keyId(key));
    }
  }

  const archived = targets.filter((t) => archivedKeys.has(keyId(t.key)));
  for (const target of archived) {
    warn(
      `[ARCHIVED] ${target.label}: entry is archived and extends nothing until it is restored ` +
        '(see docs/DEPLOYMENT.md §11).',
    );
  }

  // An absent Owner entry is normally an unbound handle, not an archived one.
  // Resolve simulates the read and returns void (Option::None) when unbound.
  const unbound = [];
  for (const target of targets) {
    if (target.role !== 'owner') continue;
    const id = keyId(target.key);
    if (live.has(id) || archivedKeys.has(id)) continue;

    const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call('resolve', nativeToScVal(target.handle, { type: 'string' })))
      .setTimeout(30)
      .build();
    const resolveSim = await rpcServer.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(resolveSim)) {
      errorLog(`[FAIL]  ${target.handle}: resolve simulation failed: ${resolveSim.error}`);
      return { exitCode: 1, live: 0, unbound: 0, archived: 0 };
    }
    if (rpc.Api.isSimulationRestore(resolveSim)) {
      warn(`[ARCHIVED] ${target.handle}: binding is archived (see docs/DEPLOYMENT.md §11).`);
      if (!archived.includes(target)) archived.push(target);
      continue;
    }
    const retval = resolveSim.result?.retval;
    if (retval && retval.switch().name === 'scvVoid') {
      unbound.push(target.handle);
      log(`[UNBOUND] ${target.handle}: no binding; nothing to extend.`);
    } else {
      warn(`[UNKNOWN] ${target.handle}: entry is missing but resolve did not return void.`);
    }
  }

  if (archived.length > 0) {
    errorLog('');
    errorLog(
      'Archived entries extend nothing. Restore them first: `stellar contract restore` — ' +
        'docs/DEPLOYMENT.md §11.',
    );
    return { exitCode: 1, live: 0, unbound: unbound.length, archived: archived.length };
  }

  // Only entries we actually read exist, so only those can be extended:
  // `ExtendFootprintTTL` on an absent key extends nothing. The simulation above
  // deliberately names every target so an archived one shows up in its restore
  // preamble; the submitted footprint must not.
  const extendable = targets.filter((t) => live.has(keyId(t.key)));

  if (!keypair) {
    log('');
    log(
      `Summary: ${extendable.length} live entries reported, ${unbound.length} unbound, 0 submitted ` +
        '(report mode; nothing was extended).',
    );
    return { exitCode: 0, live: extendable.length, unbound: unbound.length, archived: 0 };
  }

  if (extendable.length === 0) {
    log('');
    log(`Summary: 0 entries to extend, ${unbound.length} unbound, 0 archived (nothing submitted).`);
    return { exitCode: 0, live: 0, unbound: unbound.length, archived: 0 };
  }

  const source = await rpcServer.getAccount(keypair.publicKey());
  const simulated = sorobanDataOf(simulation.transactionData);
  const resources = simulated.resources();
  const sorobanData = new SorobanDataBuilder()
    .setFootprint(
      extendable.map((t) => t.key),
      [],
    )
    .setResourceFee(simulated.resourceFee())
    .setResources(resources.instructions(), resources.diskReadBytes(), resources.writeBytes())
    .build();

  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.extendFootprintTtl({ extendTo: EXTEND_TO_LEDGERS }))
    .setSorobanData(sorobanData)
    .setTimeout(60)
    .build();
  tx.sign(keypair);

  const sent = await rpcServer.sendTransaction(tx);
  if (!sent || sent.status === 'ERROR' || !sent.hash) {
    errorLog(`[FAIL]  submission rejected: ${xdrBase64(sent?.errorResult)}`);
    return { exitCode: 1, live: liveCount, unbound: unbound.length, archived: 0 };
  }

  log('');
  log(`Submitted ${sent.hash}; waiting for the result…`);

  let result;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    result = await rpcServer.getTransaction(sent.hash);
    if (result && result.status !== 'NOT_FOUND') break;
    await sleep(1000);
  }

  if (!result || result.status !== 'SUCCESS') {
    errorLog(`[FAIL]  extension transaction did not succeed: ${result?.status ?? 'no result'}`);
    return { exitCode: 1, live: liveCount, unbound: unbound.length, archived: 0 };
  }

  log(`[OK]    ${sent.hash} confirmed.`);

  // Count what the *submitted* footprint holds, not what we attempted: a key
  // that was absent (unbound, or missing but unresolved) is not in it, and
  // reporting it as extended is the false success this script exists to stop.
  const submittedFootprint = new Set(
    [
      ...tx.toEnvelope().v1().tx().ext().sorobanData().resources().footprint().readOnly(),
      ...tx.toEnvelope().v1().tx().ext().sorobanData().resources().footprint().readWrite(),
    ].map((key) => keyId(key)),
  );
  const covered = targets.filter((t) => submittedFootprint.has(keyId(t.key)));
  for (const target of covered) {
    log(`[OK]    ${target.label}: in the submitted footprint.`);
  }
  for (const target of extendable) {
    if (submittedFootprint.has(keyId(target.key))) continue;
    warn(`[SKIP]  ${target.label}: live, but not in the submitted footprint.`);
  }

  live.clear();
  await readTargets(targets);
  reportLive('[LIVE]  ');

  log('');
  log(
    `Summary: ${covered.length} of ${extendable.length} live entries in the submitted footprint ` +
      `(${unbound.length} unbound, 0 archived).`,
  );
  return {
    exitCode: covered.length > 0 ? 0 : 1,
    live: covered.length,
    unbound: unbound.length,
    archived: 0,
  };
}

function buildExtendTransaction({ passphrase, source, footprint }) {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.extendFootprintTtl({ extendTo: EXTEND_TO_LEDGERS }))
    .setSorobanData(new SorobanDataBuilder().setFootprint(footprint, []).build())
    .setTimeout(30)
    .build();
}

/** CLI entry point; returns the process exit code. */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  server,
  log = console.log,
  warn = console.warn,
  errorLog = console.error,
  sleep,
} = {}) {
  try {
    const { help, handles, instanceOnly } = parseArgs(argv);
    if (help) {
      log(USAGE);
      return 0;
    }

    const contractId =
      env.REGISTRY_CONTRACT_ID?.trim() || env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID?.trim();
    if (!contractId) {
      errorLog('Error: the Identity Registry contract id is not set.');
      errorLog(
        'Set REGISTRY_CONTRACT_ID (or NEXT_PUBLIC_IDENTITY_REGISTRY_ID) to the deployed registry; ' +
          'there is no default.',
      );
      errorLog('');
      errorLog(USAGE);
      return 1;
    }

    const summary = await runSweep({
      handles,
      instanceOnly,
      contractId,
      rpcUrl:
        env.SOROBAN_RPC_URL?.trim() || env.NEXT_PUBLIC_SOROBAN_RPC_URL?.trim() || DEFAULT_RPC_URL,
      secret: env.KEEPALIVE_SECRET?.trim() || undefined,
      server,
      log,
      warn,
      errorLog,
      sleep,
    });
    return summary.exitCode;
  } catch (err) {
    if (err instanceof UsageError) {
      errorLog(`Error: ${err.message}`);
      errorLog('');
      errorLog(USAGE);
      return 1;
    }
    errorLog(`[FAIL]  ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  });
}
