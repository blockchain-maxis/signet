/**
 * @file @signet/spec — Orbital ABI registry fallback (B-19, issue #442).
 *
 * Implements an opt-in fallback that queries the Orbital ABI registry when a contract
 * was compiled without an embedded `contractspecv0` custom section.
 *
 * Reading is performed over standard HTTP (or RPC) with zero npm dependencies.
 * Enabled only when SIGNET_SPEC_ORBITAL_FALLBACK=1 or when explicitly provided to getContractSpec.
 */

import { SPEC_JSON_SCHEMA_VERSION, type SpecJson } from '../json.ts';
import { STELLAR_SDK_VERSION } from '../sdk-version.ts';
import type { SpecFallback, SpecFallbackOptions, SpecFallbackResult } from './types.ts';

export const DEFAULT_ORBITAL_REGISTRY_URL = 'https://registry.orbital.stellar.org/api/v1';

export interface OrbitalAttestationResponse {
  readonly attestationPointer?: string;
  readonly pointer?: string;
  readonly id?: string;
  readonly attestationHash?: string;
  readonly hash?: string;
  readonly spec?: Partial<SpecJson>;
  readonly entriesXdr?: string[];
  readonly functions?: SpecJson['functions'];
  readonly types?: SpecJson['types'];
  readonly errors?: SpecJson['errors'];
  readonly events?: SpecJson['events'];
  readonly warnings?: string[];
}

export class OrbitalFallback implements SpecFallback {
  readonly name = 'orbital_registry';

  async resolve(
    address: string,
    wasmHash: string,
    options: SpecFallbackOptions = {},
  ): Promise<SpecFallbackResult | undefined> {
    const fetchFn = options.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') return undefined;

    const baseUrl = (
      options.registryUrl ??
      (typeof process !== 'undefined' && process.env?.ORBITAL_REGISTRY_URL
        ? process.env.ORBITAL_REGISTRY_URL
        : DEFAULT_ORBITAL_REGISTRY_URL)
    ).replace(/\/+$/, '');

    // Attempt lookup by WASM hash first, then by contract address
    const candidateUrls = [
      `${baseUrl}/specs/${wasmHash}`,
      `${baseUrl}/attestations/${wasmHash}`,
      `${baseUrl}/contracts/${address}/spec`,
    ];

    for (const url of candidateUrls) {
      try {
        const response = await fetchFn(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: options.signal,
        });

        if (response.status === 404 || response.status === 204) {
          continue;
        }

        if (!response.ok) {
          options.logger?.warn('Orbital registry lookup responded with error', {
            url,
            status: response.status,
          });
          continue;
        }

        const data = (await response.json()) as OrbitalAttestationResponse;
        const normalized = normalizeOrbitalResult(data, wasmHash);
        if (normalized) {
          return normalized;
        }
      } catch (err) {
        options.logger?.warn('Orbital registry request failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return undefined;
  }
}

function normalizeOrbitalResult(
  data: OrbitalAttestationResponse,
  wasmHash: string,
): SpecFallbackResult | undefined {
  if (!data || typeof data !== 'object') return undefined;

  const rawSpec = (data.spec ?? data) as Partial<SpecJson>;
  const pointer =
    data.attestationPointer ??
    data.pointer ??
    data.id ??
    `orbital://${wasmHash}`;
  const hash =
    data.attestationHash ??
    data.hash ??
    wasmHash;

  const spec: SpecJson = {
    schemaVersion: SPEC_JSON_SCHEMA_VERSION,
    wasmHash: rawSpec.wasmHash ?? wasmHash,
    sdkVersion: rawSpec.sdkVersion ?? STELLAR_SDK_VERSION,
    entriesXdr: Array.isArray(rawSpec.entriesXdr) ? rawSpec.entriesXdr : [],
    functions: Array.isArray(rawSpec.functions) ? rawSpec.functions : [],
    types: Array.isArray(rawSpec.types) ? rawSpec.types : [],
    errors: Array.isArray(rawSpec.errors) ? rawSpec.errors : [],
    events: Array.isArray(rawSpec.events) ? rawSpec.events : [],
    warnings: Array.isArray(rawSpec.warnings) ? rawSpec.warnings : [],
    provenance: 'orbital_registry',
    attestationPointer: pointer,
    attestationHash: hash,
  };

  return {
    spec,
    provenance: 'orbital_registry',
    attestationPointer: pointer,
    attestationHash: hash,
  };
}

export const orbitalFallback = new OrbitalFallback();
