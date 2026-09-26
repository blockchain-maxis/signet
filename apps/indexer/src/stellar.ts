import { Horizon, xdr, StrKey } from '@stellar/stellar-sdk';

export function createHorizonServer(horizonUrl: string): Horizon.Server {
  return new Horizon.Server(horizonUrl, { allowHttp: false });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ExtractContractReason =
  | 'not-soroban'
  | 'no-return-value'
  | 'not-contract-address'
  | 'unsupported-meta-version'
  | 'decode-error';

export type ExtractContractResult =
  | { ok: true; address: string; metaVersion: number }
  | { ok: false; reason: ExtractContractReason; metaVersion?: number };

/**
 * Parse a transaction's result_meta_xdr to extract the deployed contract address.
 * Handles TransactionMeta v3 and v4 (protocol 23+).
 * Returns a discriminated result distinguishing successful extraction from decode
 * or unsupported meta errors.
 */
export function extractContractAddress(resultMetaXdr: string): ExtractContractResult {
  let meta: xdr.TransactionMeta;
  try {
    meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
  } catch {
    return { ok: false, reason: 'decode-error' };
  }

  const switchVal = meta.switch();
  let returnVal: xdr.ScVal | null = null;
  let metaVersion: number;

  switch (switchVal) {
    case 3: {
      metaVersion = 3;
      const v3 = meta.v3();
      const sorobanMeta = v3.sorobanMeta();
      if (!sorobanMeta) {
        return { ok: false, reason: 'not-soroban', metaVersion };
      }
      returnVal = sorobanMeta.returnValue();
      break;
    }
    case 4: {
      metaVersion = 4;
      const v4 = meta.v4();
      const sorobanMeta = v4.sorobanMeta();
      if (!sorobanMeta) {
        return { ok: false, reason: 'not-soroban', metaVersion };
      }
      returnVal = sorobanMeta.returnValue();
      break;
    }
    default:
      return {
        ok: false,
        reason: 'unsupported-meta-version',
        metaVersion: typeof switchVal === 'number' ? switchVal : undefined,
      };
  }

  if (!returnVal) {
    return { ok: false, reason: 'no-return-value', metaVersion };
  }

  try {
    if (returnVal.switch().name !== 'scvAddress') {
      return { ok: false, reason: 'not-contract-address', metaVersion };
    }

    const addr = returnVal.address();
    if (addr.switch().name !== 'scAddressTypeContract') {
      return { ok: false, reason: 'not-contract-address', metaVersion };
    }

    const contractId = addr.contractId();
    const address = StrKey.encodeContract(Buffer.from(contractId as unknown as Uint8Array));
    return { ok: true, address, metaVersion };
  } catch {
    return { ok: false, reason: 'decode-error', metaVersion };
  }
}
