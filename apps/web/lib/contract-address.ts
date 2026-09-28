import { StrKey, Address, xdr } from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';

/**
 * Validates whether a string is a valid Soroban contract address (C... StrKey)
 * including validating the StrKey checksum.
 */
export function isContractAddress(s: string): boolean {
  if (typeof s !== 'string' || !s.startsWith('C') || s.length !== 56) {
    return false;
  }
  return StrKey.isValidContract(s);
}

export interface DeriveContractIdOptions {
  deployer: string; // G... or C... address
  salt: string | Buffer | Uint8Array; // 32 bytes as hex string, base64 string, or byte buffer
  networkPassphrase: string;
}

/**
 * Normalizes salt input into a 32-byte Buffer.
 */
function normalizeSalt(salt: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(salt)) {
    if (salt.length !== 32)
      throw new RangeError(`Salt buffer must be exactly 32 bytes, got ${salt.length}`);
    return salt;
  }
  if (salt instanceof Uint8Array) {
    if (salt.length !== 32)
      throw new RangeError(`Salt Uint8Array must be exactly 32 bytes, got ${salt.length}`);
    return Buffer.from(salt);
  }
  if (typeof salt === 'string') {
    const trimmed = salt.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    // Try base64
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) {
      return b64;
    }
    throw new TypeError(
      `Salt string must be 32 bytes encoded in hex (64 chars) or base64 (44 chars), got: '${salt}'`,
    );
  }
  throw new TypeError('Salt must be a 32-byte Buffer, Uint8Array, hex string, or base64 string');
}

/**
 * Derives a Soroban contract ID from deployer address, salt, and network passphrase.
 *
 * Preimage formula:
 * sha256(HashIdPreimage::EnvelopeTypeContractId {
 *   networkId: sha256(passphrase),
 *   contractIdPreimage: FromAddress { address, salt }
 * })
 */
export function deriveContractId(options: DeriveContractIdOptions): string {
  const { deployer, salt, networkPassphrase } = options;
  const saltBuf = normalizeSalt(salt);

  const networkId = createHash('sha256').update(networkPassphrase).digest();
  const address = Address.fromString(deployer);

  const contractIdPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: address.toScAddress(),
      salt: saltBuf,
    }),
  );

  const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage,
    }),
  );

  const preimageBytes = hashIdPreimage.toXDR();
  const contractIdHash = createHash('sha256').update(preimageBytes).digest();
  return StrKey.encodeContract(contractIdHash);
}
