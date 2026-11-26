/**
 * @file Replays recorded Horizon responses to the SDK's own client (#974).
 *
 * A worker test used to stand in for `Horizon.Server` with an object written
 * by hand, and the records in it were written by hand too. That is how a
 * `function` value Horizon never sends stayed in the tests (#959). Here the
 * server is the real one from `@stellar/stellar-sdk`: it builds the request,
 * parses the records and follows the page links as it does in production.
 * Only the network is replaced, by a `fetch` that answers from recordings.
 *
 * A request nothing was recorded for is answered 404, in Horizon's own
 * problem format, and listed in `unanswered`, so a test can tell "Horizon
 * said there is none" apart from "this test has no recording of that".
 */

import type { FixtureEnvelope } from './index.ts';

/** One response to replay: a Horizon path with its query, and the body Horizon gave. */
export interface ReplayedResponse {
  /** As in a fixture's `request.methodOrPath`, e.g. `/transactions/<hash>`. */
  readonly path: string;
  readonly body: unknown;
}

export interface HorizonReplay {
  /** The server URL to construct `Horizon.Server` with. */
  readonly url: string;
  /** Every request made, in order: path and query, the query sorted by name. */
  readonly requests: string[];
  /** The requests among them that no recording answered. */
  readonly unanswered: string[];
  /** Puts back the `fetch` that was there before. Call it when the test ends. */
  restore(): void;
}

const REPLAY_URL = 'https://horizon.replay.test';

/** A path and its query with the parameters in name order, so `?a=1&b=2` and `?b=2&a=1` are one request. */
function canonical(pathAndQuery: string): string {
  const url = new URL(pathAndQuery, REPLAY_URL);
  const params = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  return query ? `${url.pathname}?${query}` : url.pathname;
}

function isEnvelope(value: ReplayedResponse | FixtureEnvelope): value is FixtureEnvelope {
  return 'request' in value && 'payload' in value;
}

/**
 * Replaces the global `fetch` with one that answers Horizon requests from
 * `responses`, until `restore()`. A fixture envelope recorded from Horizon
 * can be passed as it is; anything else as `{ path, body }`. A later entry
 * for the same request replaces an earlier one.
 */
export function replayHorizon(
  responses: ReadonlyArray<ReplayedResponse | FixtureEnvelope>,
): HorizonReplay {
  const recorded = new Map<string, unknown>();
  for (const response of responses) {
    if (isEnvelope(response)) {
      if (response.request.endpoint !== 'horizon') {
        throw new Error(`not a Horizon recording: ${response.request.methodOrPath}`);
      }
      recorded.set(canonical(response.request.methodOrPath), response.payload);
    } else {
      recorded.set(canonical(response.path), response.body);
    }
  }

  const requests: string[] = [];
  const unanswered: string[] = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.origin !== REPLAY_URL) {
      throw new Error(
        `replayHorizon: a request left for ${url.origin}; nothing may reach the network`,
      );
    }
    const request = canonical(url.pathname + url.search);
    requests.push(request);
    const body = recorded.get(request);
    if (body === undefined) {
      unanswered.push(request);
      return new Response(
        JSON.stringify({
          type: 'https://stellar.org/horizon-errors/not_found',
          title: 'Resource Missing',
          status: 404,
          detail: 'No response was recorded for this request.',
        }),
        { status: 404, headers: { 'content-type': 'application/problem+json; charset=utf-8' } },
      );
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/hal+json; charset=utf-8' },
    });
  }) as typeof fetch;

  return {
    url: REPLAY_URL,
    requests,
    unanswered,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
