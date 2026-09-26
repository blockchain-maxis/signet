/**
 * @file @signet/spec
 *
 * Typed error hierarchy for spec reading, extraction, and decoding failures (§1.5 of docs/CONTRACT_DOCS_DESIGN.md).
 */

import type { Network } from '@signet/types';

/**
 * Base class for all spec reader errors.
 */
export abstract class SpecReadError extends Error {
  abstract readonly kind: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a contract address is not found on the requested network.
 */
export class ContractNotFound extends SpecReadError {
  readonly kind = 'contract_not_found' as const;
  readonly address: string;
  readonly network: Network;

  constructor(address: string, network: Network) {
    super(`Contract ${address} not found on ${network}`);
    this.address = address;
    this.network = network;
  }
}

/**
 * Reasons why a deployed contract has no interface specification.
 */
export type NoInterfaceReason = 'no_section' | 'stellar_asset_contract' | 'empty_section';

/**
 * Thrown or reported when a contract exists but publishes no `contractspecv0` interface.
 */
export class NoInterface extends SpecReadError {
  readonly kind = 'no_interface' as const;
  readonly reason: NoInterfaceReason;

  constructor(reason: NoInterfaceReason) {
    super(
      reason === 'stellar_asset_contract'
        ? 'Stellar Asset Contract has built-in interface without custom spec section'
        : 'Contract publishes no custom interface section',
    );
    this.reason = reason;
  }
}

/**
 * Thrown when a custom section is present but cannot be decoded by the current SDK.
 */
export class InterfaceUnreadable extends SpecReadError {
  readonly kind = 'interface_unreadable' as const;
  readonly sdkVersion: string;

  constructor(sdkVersion: string, cause?: unknown) {
    super(`Interface could not be read using @stellar/stellar-sdk@${sdkVersion}`, { cause });
    this.sdkVersion = sdkVersion;
  }
}

/**
 * Thrown when the RPC endpoint is unreachable or fails to respond.
 */
export class RpcUnavailable extends SpecReadError {
  readonly kind = 'rpc_unavailable' as const;
  readonly rpcUrl: string;

  constructor(rpcUrl: string, cause?: unknown) {
    super(`Soroban RPC unavailable at ${rpcUrl}`, { cause });
    this.rpcUrl = rpcUrl;
  }
}

/**
 * Thrown when supplied bytes are not a valid WebAssembly module.
 */
export class InvalidWasm extends SpecReadError {
  readonly kind = 'invalid_wasm' as const;

  constructor(cause?: unknown) {
    super('Supplied buffer is not a valid WebAssembly module', { cause });
  }
}

/**
 * Union of all concrete spec read errors.
 */
export type ConcreteSpecReadError =
  | ContractNotFound
  | NoInterface
  | InterfaceUnreadable
  | RpcUnavailable
  | InvalidWasm;

/**
 * Type guard for SpecReadError instances.
 */
export function isSpecReadError(error: unknown): error is ConcreteSpecReadError {
  return error instanceof SpecReadError;
}
