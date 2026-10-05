/**
 * @file apps/web/lib/contract-not-found.ts
 *
 * What the contract route's 404 says (#459). Pure, so the wording and the
 * links are unit-testable; `contract/not-found.tsx` only renders the result.
 *
 * `notFound()` fires when the handle did not deploy the contract, or when the
 * address is not a contract address at all. The boundary cannot tell which, so
 * the copy is true of both. The point of the page is that a wrong-handle link
 * is still useful: it names the handle, links back to its profile, and links
 * the address to the explorer.
 *
 * Client-safe: no Node imports, so the client boundary can use it.
 */

import { isValidHandle } from '@signet/types';
import { stellarExpertContractUrl } from './network.ts';

/**
 * Shape of a contract address: C-prefixed StrKey, 56 base32 characters. A shape
 * check, not `isContractAddress` (`contract-address.ts`), which verifies the
 * checksum through `@stellar/stellar-sdk` and so cannot ship to the browser.
 * The explorer simply shows nothing for a well-shaped address with a bad checksum.
 */
const ADDRESS_SHAPE = /^C[A-Z2-7]{55}$/;

export interface ContractNotFoundModel {
  heading: string;
  /** One or more sentences, in order. */
  body: string[];
  /** `/p/{handle}`, or null when the handle is missing or malformed. */
  profileHref: string | null;
  /** The handle to show as `@{handle}`, or null when it should not be echoed. */
  handle: string | null;
  /** Stellar Expert page for the address, or null when it is not shaped like one. */
  explorerHref: string | null;
}

/** Params as `useParams()` hands them over: a string, an array, or missing. */
type Param = string | string[] | undefined;

function single(value: Param): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildContractNotFound(params: {
  handle?: Param;
  address?: Param;
}): ContractNotFoundModel {
  const rawHandle = single(params.handle);
  const address = single(params.address);

  // Echo only a handle the registry could contain. Anything else is whatever
  // was typed into the URL, and has no business on a page.
  const handle = rawHandle !== undefined && isValidHandle(rawHandle) ? rawHandle : null;
  const explorerHref =
    address !== undefined && ADDRESS_SHAPE.test(address) ? stellarExpertContractUrl(address) : null;

  const owner = handle === null ? 'this developer' : `@${handle}`;
  const body = [`This contract isn't part of ${owner}'s record.`];
  body.push(
    explorerHref === null
      ? "The address in this link doesn't look like a contract address."
      : 'It may belong to another developer, or be on a different network.',
  );

  return {
    heading: 'Contract not found',
    body,
    profileHref: handle === null ? null : `/p/${handle}`,
    handle,
    explorerHref,
  };
}
