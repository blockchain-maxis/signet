import { getConfiguredNetwork } from '../../cli-link.ts';
import { REGISTRY_CONTRACT_ID } from '../../chain.ts';
import {
  resolveHandleDetailed,
  type HandleResolution,
  type RegistryReadOptions,
} from '../../server/registry-read.ts';
import { V1Error } from './http.ts';

export interface V1ResolveHandleData {
  handle: string;
  wallet: string;
  network: string;
  registryContract: string;
  archived?: boolean;
  restorePreamble?: unknown;
}

export interface V1ResolveHandleOptions {
  registry?: RegistryReadOptions;
  network?: string;
  registryContract?: string;
}

/**
 * Resolve a handle directly against the on-chain Identity Registry with no database dependency.
 *
 * Wraps `resolveHandleDetailed`:
 * - Bound: returns `{ handle, wallet, network, registryContract }`
 * - Archived: reports an archived entry as returned by `resolveHandleDetailed`
 * - Unbound: throws 404 `not_found`
 * - Error: throws 503 `unavailable` with `{ reason: 'simulation_error' }`
 * - Unconfigured: throws 503 `unavailable` with `{ reason: 'unconfigured' }`
 */
export async function getV1ResolveHandle(
  handle: string,
  options: V1ResolveHandleOptions = {},
): Promise<V1ResolveHandleData> {
  const network = options.network ?? getConfiguredNetwork();
  const registryContract =
    options.registryContract ??
    (process.env.REGISTRY_CONTRACT_ID ??
      process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ??
      REGISTRY_CONTRACT_ID);

  const res: HandleResolution = await resolveHandleDetailed(handle, options.registry);

  if (res.status === 'unconfigured') {
    throw new V1Error(
      'unavailable',
      'The Identity Registry contract is not configured on this deployment.',
      { reason: 'unconfigured' },
    );
  }

  if (res.status === 'error') {
    throw new V1Error(
      'unavailable',
      'Unable to resolve handle against the Identity Registry.',
      { reason: 'simulation_error' },
    );
  }

  if (res.status === 'unbound') {
    throw new V1Error('not_found', `Handle '${handle}' is not bound in the registry.`, {
      handle,
    });
  }

  if (res.status === 'archived') {
    return {
      handle,
      wallet: '',
      network,
      registryContract,
      archived: true,
      ...(res.restorePreamble !== undefined ? { restorePreamble: res.restorePreamble } : {}),
    };
  }

  return {
    handle,
    wallet: res.wallet,
    network,
    registryContract,
  };
}
