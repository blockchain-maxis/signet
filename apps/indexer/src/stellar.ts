import { Horizon, xdr, StrKey } from '@stellar/stellar-sdk';

export function createHorizonServer(horizonUrl: string): Horizon.Server {
  return new Horizon.Server(horizonUrl, { allowHttp: false });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a transaction's result_meta_xdr to extract the deployed contract address.
 * Returns null if this isn't a Soroban V3 meta or doesn't contain a contract address.
 */
export function extractContractAddress(resultMetaXdr: string): string | null {
  try {
    const meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');

    // Only Soroban transactions (V3) carry contract creation results
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v3 = (meta as any).v3?.() as { sorobanMeta(): SorobanMeta | null } | undefined;
    if (!v3) return null;

    const sorobanMeta = v3.sorobanMeta();
    if (!sorobanMeta) return null;

    const returnVal = sorobanMeta.returnValue() as xdr.ScVal;
    if (returnVal.switch().name !== 'scvAddress') return null;

    const addr = returnVal.address() as xdr.ScAddress;
    if (addr.switch().name !== 'scAddressTypeContract') return null;

    return StrKey.encodeContract(Buffer.from(addr.contractId() as unknown as Uint8Array));
  } catch {
    return null;
  }
}

// Internal type for the sorobanMeta accessor
interface SorobanMeta {
  returnValue(): xdr.ScVal;
}
