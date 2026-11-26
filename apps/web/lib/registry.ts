'use client';

/**
 * Client-side helper for claiming a Signet handle on the on-chain Identity
 * Registry (see `packages/contracts/identity-registry`).
 *
 * The flow: build a `claim(handle, wallet)` invocation, let Soroban simulate +
 * assemble it, have the connected wallet sign it (this is the cryptographic
 * proof of wallet ownership), then submit. Submission requires the registry's
 * deployed contract id — until that's configured, `claimHandle` throws
 * `RegistryNotConfiguredError` so the UI can show an honest "coming soon"
 * state instead of a broken button.
 */

import { signTransaction, NETWORK_PASSPHRASE } from './wallet';

const CONTRACT_ID = process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ?? '';
const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

export class RegistryNotConfiguredError extends Error {
  constructor() {
    super('The Identity Registry contract is not yet deployed on this network.');
    this.name = 'RegistryNotConfiguredError';
  }
}

export function isRegistryConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

export interface ClaimResult {
  hash: string;
}

/** Claim `handle` for the connected `walletAddress`. */
export async function claimHandle(handle: string, walletAddress: string): Promise<ClaimResult> {
  if (!isRegistryConfigured()) throw new RegistryNotConfiguredError();

  const sdk: any = await import('@stellar/stellar-sdk');
  const { Contract, TransactionBuilder, BASE_FEE, Address, nativeToScVal, rpc } = sdk;

  const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(CONTRACT_ID);

  const op = contract.call(
    'claim',
    nativeToScVal(handle, { type: 'string' }),
    new Address(walletAddress).toScVal(),
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  // Simulate + assemble (adds Soroban resource footprint and fees).
  const prepared = await server.prepareTransaction(tx);

  const signedXdr = await signTransaction(prepared.toXDR(), walletAddress);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const sent = await server.sendTransaction(signedTx);
  if (sent.status === 'ERROR') {
    throw new Error(`Claim submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }

  return { hash: sent.hash };
}

export interface RestoreResult {
  hash: string;
}

/**
 * Restore the archived registry entry behind `handle`, paid for by the
 * connected `walletAddress`. Any account may restore a ledger entry, and doing
 * so changes no ownership.
 *
 * `contractId` names the registry to restore against. The profile page passes
 * the one its server read the archived state from, so the button restores
 * exactly the entry the page reported; it falls back to the build's public id.
 */
export async function restoreHandleBinding(
  handle: string,
  walletAddress: string,
  options: { contractId?: string } = {},
): Promise<RestoreResult> {
  const contractId = options.contractId || CONTRACT_ID;
  if (!contractId) throw new RegistryNotConfiguredError();

  // Both stay dynamic: the SDK must not enter the profile page's first load.
  const [{ Account, Contract, TransactionBuilder, BASE_FEE, nativeToScVal, rpc }, { buildRestoreTransaction }] =
    await Promise.all([import('@stellar/stellar-sdk'), import('./registry-transactions.ts')]);

  const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(contractId);

  // Simulated from a copy: `build()` advances the source's sequence number,
  // and the restore must carry the account's next one, not the one after it.
  const resolveTx = new TransactionBuilder(
    new Account(account.accountId(), account.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE },
  )
    .addOperation(contract.call('resolve', nativeToScVal(handle, { type: 'string' })))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(resolveTx);
  const restoreTx = buildRestoreTransaction(account, sim, NETWORK_PASSPHRASE);

  const signedXdr = await signTransaction(restoreTx.toXDR(), walletAddress);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const sent = await server.sendTransaction(signedTx);
  if (sent.status === 'ERROR') {
    throw new Error(`Restore submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }

  return { hash: sent.hash };
}
