/**
 * Server-side, read-only lookups against the on-chain Identity Registry
 * (`packages/contracts/identity-registry`). Unlike `lib/registry.ts` (the
 * client-side `claim` write path), this simulates read calls over Soroban RPC —
 * no signing, no submission — so server components can attribute a wallet's
 * on-chain binding even when the indexer/database isn't populated.
 *
 * Every function fails closed: if the registry contract id isn't configured, or
 * the RPC is unreachable, they return `null`/`false` so callers show an honest
 * empty state instead of throwing.
 */

function contractId(): string {
  return process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ?? '';
}

/** True once the Identity Registry contract id is configured for this network. */
export function isRegistryConfigured(): boolean {
  return contractId().length > 0;
}

/**
 * Resolves the handle bound to `wallet` on-chain, or `null` when the registry is
 * unconfigured, the wallet is unbound, or the RPC read fails. Simulates the
 * contract's read-only `lookup(wallet) -> Option<String>`.
 */
export async function lookupHandleOnchain(wallet: string): Promise<string | null> {
  const id = contractId();
  if (!id) return null;

  const rpcUrl = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet').toLowerCase();

  try {
    const { Contract, TransactionBuilder, BASE_FEE, Address, Account, Networks, rpc, scValToNative } =
      await import('@stellar/stellar-sdk');

    const passphrase =
      network === 'mainnet' || network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
    const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    const contract = new Contract(id);

    // Read-only: a dummy source + sequence is fine, the tx is only simulated.
    const tx = new TransactionBuilder(new Account(wallet, '0'), {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call('lookup', new Address(wallet).toScVal()))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;

    const handle = scValToNative(sim.result.retval) as unknown;
    return typeof handle === 'string' && handle.length > 0 ? handle : null;
  } catch {
    return null;
  }
}
