/**
 * @file Where the permalink page reads one contract's interface from.
 *
 * This is the page's only side effect, and it is deliberately the smallest
 * possible thing: a function of the contract's identity to a result the page
 * can branch on, that never throws. Everything the page decides is a pure
 * function of that result (`resolveFunctionPage`), so the page's behaviour is
 * testable without a network, a database, or a decoded WASM.
 *
 * It is also a seam that #464 fills in, and the reason is worth stating
 * plainly: **the repository has no spec reader.** `packages/spec` ships the
 * decoded types, the typed failures and the LRU cache, but nothing that turns
 * bytes into a spec, because that is #424 and #425, both unstarted. So there
 * is no honest way for this page to render a real interface today, and
 * inventing a reader here would take work that is another issue's scope and
 * would have to be thrown away when that issue lands.
 *
 * So the page is built, and it says the truth. When the interface cannot be
 * read, the page renders that plainly instead of a 404, because an
 * unreadable interface says nothing about whether the URL is right.
 *
 * #464 replaces this file's body with a call to
 * `loadContractSpec({ address, network, wasmHash })` and widens
 * `FunctionSourceReason` to its typed failure kinds. The page's rendering
 * branches on the reason, so that change is confined to this file, the reason
 * union in `lib/docs/function-permalink.ts`, and the two views of the
 * unavailable state.
 *
 * Colocated with the page rather than in `lib/server/`, because #464 owns
 * `apps/web/lib/server/contract-spec.ts` and two files competing for one path
 * is a merge conflict waiting to happen.
 */
import { cache } from 'react';
import type { FunctionSourceResult } from '@/lib/docs/function-permalink';

export interface ContractSpecRequest {
  /** The contract being documented. */
  address: string;
  /**
   * Hash of the deployed WASM, when the indexer recorded one. It is the
   * correct cache key (design §4.1) and it is `null` on the Horizon
   * attribution path, so a future reader has to cope with its absence rather
   * than assume it.
   */
  wasmHash: string | null;
}

/**
 * Read one contract's interface. Wrapped in React's `cache` so
 * `generateMetadata` and the page component share a single read per request,
 * the same way `attributeContract` does for the shell.
 */
export const loadContractSpec = cache(
  async (_request: ContractSpecRequest): Promise<FunctionSourceResult> => ({
    ok: false,
    reason: 'spec_reader_unavailable',
  }),
);
