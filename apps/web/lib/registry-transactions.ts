import {
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc,
  type Account,
  type Transaction,
} from '@stellar/stellar-sdk';

/**
 * Build the unsigned `restoreFootprint` transaction for an archived entry from
 * the simulation that reported it (#897). Pure: no RPC, no wallet, so the
 * transaction's shape is unit-tested on its own.
 *
 * The restore has to name what it is restoring. `restorePreamble` is where the
 * network puts exactly that: `transactionData` is the footprint of the
 * archived entries, and `minResourceFee` is what restoring them costs. A
 * `restoreFootprint` operation built without adopting that Soroban data
 * carries an empty footprint and restores nothing.
 *
 * Lives apart from `registry.ts` so that module can keep importing the SDK
 * lazily; `restoreHandleBinding` imports this one the same way.
 */
export function buildRestoreTransaction(
  account: Account,
  sim: rpc.Api.SimulateTransactionResponse,
  networkPassphrase: string,
): Transaction {
  if (!rpc.Api.isSimulationRestore(sim)) {
    throw new Error(
      'The handle is not in an archived state: the simulation names nothing to restore.',
    );
  }
  const { transactionData, minResourceFee } = sim.restorePreamble;
  const fee = (BigInt(BASE_FEE) + BigInt(minResourceFee)).toString();

  return new TransactionBuilder(account, { fee, networkPassphrase })
    .setSorobanData(transactionData.build())
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();
}
