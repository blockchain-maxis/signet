/**
 * `GET /api/v1/profiles/{handle}/contracts/{address}` (#632): did this handle
 * deploy this contract? A 200 with the contract, or a 404.
 *
 * The answer is the contract page's own (`attributeContract`, #444): the
 * indexer's `Contract` rows for any of the handle's wallets, or, with no
 * database, a walk of the wallets' Horizon history for the deploy. So the API
 * and `/p/{handle}/contract/{address}` never disagree.
 *
 * A contract another handle deployed and a contract that does not exist give
 * the same 404, byte for byte, so probing handles cannot reveal who deployed
 * what.
 */
import { attributeContract, type Attribution } from '../../contract-attribution.ts';
import { ok, parseAddress, parseHandle, V1Error, withV1 } from './http.ts';

export const PROFILE_CONTRACT_CACHE_CONTROL = 'public, s-maxage=300';

export interface V1ProfileContractAttribution {
  /** 'indexer' when the database answered, 'deployer-check' on the Horizon walk. */
  method: 'indexer' | 'deployer-check';
  /** The handle's wallet that deployed it. */
  wallet: string;
}

export interface V1AttributedContract {
  address: string;
  handle: string;
  deployer: string;
  deployedAt: string;
  network: string;
  wasmHash: string | null;
  attribution: V1ProfileContractAttribution;
}

export interface V1ProfileContractDeps {
  attribute?: (handle: string, address: string) => Promise<Attribution>;
}

/**
 * The one 404 for every contract this handle did not deploy. It echoes
 * nothing from the request, so every such 404 is the same bytes.
 */
export const NOT_ATTRIBUTED_MESSAGE = 'No contract with this address is attributed to this handle.';

export async function getV1ProfileContract(
  handle: string,
  address: string,
  deps: V1ProfileContractDeps = {},
): Promise<V1AttributedContract> {
  const verdict = await (deps.attribute ?? attributeContract)(handle, address);
  switch (verdict.status) {
    case 'invalid':
      throw new V1Error('bad_request', `Invalid C… contract ID "${address}".`, {
        parameter: 'address',
      });
    case 'unavailable':
      throw new V1Error('unavailable', 'Contract attribution is unavailable. Try again later.');
    case 'not-attributed':
      throw new V1Error('not_found', NOT_ATTRIBUTED_MESSAGE);
  }
  const c = verdict.contract;
  return {
    address: c.address,
    handle,
    deployer: c.deployerPubkey,
    deployedAt: new Date(c.deployedAt).toISOString(),
    network: c.network,
    wasmHash: c.wasmHash,
    attribution: {
      method: verdict.source === 'database' ? 'indexer' : 'deployer-check',
      wallet: c.wallet ?? c.deployerPubkey,
    },
  };
}

type Ctx = { params: Promise<{ handle: string; address: string }> };

/** The route's handler, with the attribution injectable for tests. */
export function profileContractHandler(deps: V1ProfileContractDeps = {}) {
  return (req: Request, ctx: Ctx): Promise<Response> =>
    withV1(
      async () => {
        const params = await ctx.params;
        const handle = parseHandle(params.handle);
        const address = parseAddress(params.address, 'C');
        return ok(await getV1ProfileContract(handle, address, deps));
      },
      { cache: PROFILE_CONTRACT_CACHE_CONTROL },
    )(req);
}
