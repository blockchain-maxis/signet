/**
 * @file @signet/spec - Fallback interfaces for contracts without embedded specs (B-19, issue #442).
 */

import type { SpecJson } from '../json.ts';

export interface SpecFallbackResult {
  readonly spec: SpecJson;
  readonly provenance: 'orbital_registry';
  /** Pointer or URI identifying the attestation in the registry. */
  readonly attestationPointer: string;
  /** Cryptographic hash of the attestation record. */
  readonly attestationHash: string;
}

export interface SpecFallbackOptions {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly registryUrl?: string;
  readonly rpcUrl?: string;
  readonly logger?: {
    warn(message: string, context?: Record<string, unknown>): void;
  };
}

export interface SpecFallback {
  readonly name: string;
  resolve(
    address: string,
    wasmHash: string,
    options?: SpecFallbackOptions,
  ): Promise<SpecFallbackResult | undefined | null>;
}
