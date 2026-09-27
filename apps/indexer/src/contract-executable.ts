import { Contract, xdr, type rpc } from '@stellar/stellar-sdk';
import { withRetry } from './retry.js';

/**
 * A contract instance's executable, as recorded on chain: either a WASM blob
 * identified by its SHA-256 hash, or the built-in Stellar Asset Contract.
 */
export type ContractExecutableInfo = { type: 'wasm'; wasmHash: string } | { type: 'stellar_asset' };

/**
 * Reads a deployed contract's executable, where `address` is the contract
 * address the deployment worker just extracted from the transaction meta.
 *
 * Resolves `null` when there is no live instance to read — the common case for
 * the old deployments #372's backward walk recovers, whose instances are long
 * archived. Throws when the read itself failed; the worker turns both into a
 * null hash, but only a thrown error carries the cause.
 */
export type ReadExecutable = (address: string) => Promise<ContractExecutableInfo | null>;

export type LedgerEntriesServer = Pick<rpc.Server, 'getLedgerEntries'>;

/** One entry of a `getLedgerEntries` response, in either shape seen in this repo. */
export interface LedgerEntryLike {
  key: string | xdr.LedgerKey;
  /** Base64 `LedgerEntryData`, as RPC sends it. */
  xdr?: string;
  /** The decoded form, which SDK 16's `getLedgerEntries` hands back instead. */
  val?: xdr.LedgerEntryData;
}

const EXECUTABLE_LABEL = 'deployments.executable';

function toLedgerEntryData(entry: LedgerEntryLike): xdr.LedgerEntryData | null {
  if (entry.val && typeof (entry.val as xdr.LedgerEntryData).switch === 'function') {
    return entry.val as xdr.LedgerEntryData;
  }
  if (typeof entry.xdr !== 'string') return null;
  try {
    return xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
  } catch {
    return null;
  }
}

function keyMatches(entryKey: LedgerEntryLike['key'], wanted: string): boolean {
  if (typeof entryKey === 'string') return entryKey === wanted;
  try {
    return entryKey.toXDR('base64') === wanted;
  } catch {
    return false;
  }
}

/**
 * Pick the requested contract's instance entry out of a `getLedgerEntries`
 * response and read its executable.
 *
 * Exported for tests: the entries recorded from testnet by #413 reach this
 * function as base64 XDR, which is the part worth pinning down without a live
 * network.
 */
export function decodeInstanceExecutable(
  entries: LedgerEntryLike[],
  requestedKey: xdr.LedgerKey,
): ContractExecutableInfo | null {
  const wanted = requestedKey.toXDR('base64');
  const entry = entries.find((e) => keyMatches(e.key, wanted));
  if (!entry) return null;

  const data = toLedgerEntryData(entry);
  if (!data || data.switch().name !== 'contractData') return null;

  let executable: xdr.ContractExecutable;
  try {
    // Anything other than a `SCV_CONTRACT_INSTANCE` val throws here — an
    // ordinary ledger entry stored under the instance key has no executable.
    executable = data.contractData().val().instance().executable();
  } catch {
    return null;
  }

  switch (executable.switch().name) {
    case 'contractExecutableStellarAsset':
      return { type: 'stellar_asset' };
    case 'contractExecutableWasm':
      return { type: 'wasm', wasmHash: executable.wasmHash().toString('hex').toLowerCase() };
    default:
      return null;
  }
}

/**
 * The production `ReadExecutable`: one `getLedgerEntries` call for the
 * contract's instance key, retried like every other network read here.
 *
 * Errors are deliberately not swallowed — the worker records the contract with
 * a null hash either way (#416 backfills it), and logs the cause.
 */
export function createContractExecutableReader(server: LedgerEntriesServer): ReadExecutable {
  return async function readExecutable(address: string): Promise<ContractExecutableInfo | null> {
    const key = new Contract(address).getFootprint();
    const response = await withRetry(() => server.getLedgerEntries(key), {
      label: EXECUTABLE_LABEL,
    });
    return decodeInstanceExecutable(response.entries ?? [], key);
  };
}
