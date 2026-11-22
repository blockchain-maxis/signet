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

import {
  BASE_FEE,
  Contract,
  Operation,
  Transaction,
  TransactionBuilder,
  Address,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { signTransaction, NETWORK_PASSPHRASE } from './wallet.ts';

function getContractId(): string {
  return process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ?? process.env.REGISTRY_CONTRACT_ID ?? '';
}

function getRpcUrl(): string {
  return process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
}

export class RegistryNotConfiguredError extends Error {
  constructor() {
    super('The Identity Registry contract is not yet deployed on this network.');
    this.name = 'RegistryNotConfiguredError';
  }
}

export function isRegistryConfigured(): boolean {
  return getContractId().length > 0;
}

export interface ClaimResult {
  hash: string;
}

/** Claim `handle` for the connected `walletAddress`. */
export async function claimHandle(handle: string, walletAddress: string): Promise<ClaimResult> {
  if (!isRegistryConfigured()) throw new RegistryNotConfiguredError();

  const rpcUrl = getRpcUrl();
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(getContractId());

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
 * Pure function: build an unsigned restore footprint transaction from an account
 * and a simulation response that carries a `restorePreamble`.
 *
 * Adopts `restorePreamble.transactionData` and fee `BASE_FEE + minResourceFee`.
 */
export function buildRestoreTransaction(
  account: any,
  sim: any,
  networkPassphrase: string = NETWORK_PASSPHRASE,
): Transaction {
  if (!sim || !sim.restorePreamble || !sim.restorePreamble.transactionData) {
    throw new Error('Simulation is not in an archived state; restore preamble missing.');
  }

  const { transactionData, minResourceFee } = sim.restorePreamble;
  const fee = (BigInt(BASE_FEE) + BigInt(minResourceFee ?? '0')).toString();

  const sorobanData =
    typeof transactionData.build === 'function'
      ? transactionData.build()
      : typeof transactionData === 'string'
        ? xdr.SorobanTransactionData.fromXDR(transactionData, 'base64')
        : transactionData;

  const restoreTx = new TransactionBuilder(account, {
    fee,
    networkPassphrase,
  })
    .setSorobanData(sorobanData)
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();

  return restoreTx;
}

/** Restore archived storage footprint for `handle` using the connected `walletAddress`. */
export async function restoreHandleBinding(
  handle: string,
  walletAddress: string,
): Promise<RestoreResult> {
  if (!isRegistryConfigured()) throw new RegistryNotConfiguredError();

  const rpcUrl = getRpcUrl();
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(getContractId());

  const resolveTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('resolve', nativeToScVal(handle, { type: 'string' })))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(resolveTx);
  if (!rpc.Api.isSimulationRestore(sim)) {
    throw new Error(`Handle '${handle}' is not in an archived state.`);
  }

  const restoreTx = buildRestoreTransaction(account, sim, NETWORK_PASSPHRASE);

  const signedXdr = await signTransaction(restoreTx.toXDR(), walletAddress);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const sent = await server.sendTransaction(signedTx);
  if (sent.status === 'ERROR') {
    throw new Error(`Restore submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }

  return { hash: sent.hash };
}
