# @signet/sdk

Read-only TypeScript client for the [Signet](https://github.com/blockchain-maxis/signet)
API. Signet is a verifiable developer career record built on Stellar/Soroban: developers
bind a deployment wallet to a handle on-chain, an indexer collects everything that wallet
has deployed and invoked, and the result is served as a public profile. This SDK reads
those profiles from a Signet deployment's versioned REST API (`/api/v1`, documented in
[`docs/API_V1.md`](../../docs/API_V1.md)) over plain HTTP GET.

## Install

```bash
pnpm add @signet/sdk      # npm install @signet/sdk / yarn add @signet/sdk
```

> **Not on npm yet.** `packages/sdk` is still `"private": true` inside this monorepo and
> is consumed as `"@signet/sdk": "workspace:*"`. Publishing is tracked in
> [#60](https://github.com/blockchain-maxis/signet/issues/60); until it lands, use the
> workspace dependency or a git dependency on this repo.

## Migrating from 0.0.x

0.1.0 moves the client from the web app's internal tRPC routes onto `/api/v1`. The method
names are the same; two things changed.

- **`getProfile` returns the v1 profile.** `ProfileResponse` was
  `{ handle, profile: { name, bio, wallet, joined }, stats: { invocations, uniqueFunctions, reputation } }`.
  It is now the v1 `Profile`:

  | 0.0.x | 0.1.0 |
  |--|--|
  | `res.profile.name` | `res.displayName ?? res.handle` |
  | `res.profile.bio` | `res.bio` (nullable) |
  | `res.profile.wallet` | `res.primaryWallet` (nullable), and every wallet in `res.wallets` |
  | `res.profile.joined` | `res.joinedAt` (ISO-8601, nullable) |
  | `res.stats.invocations` | `res.counts.invocations` (`res.countsAreLowerBounds` says when it is a floor) |
  | `res.stats.uniqueFunctions`, `res.stats.reputation` | not part of v1 |

  The types `SignetProfile`, `ProfileStats` and `ProfileStatsResult` are no longer
  exported.
- **Errors are typed, and fewer things are `null`.** A 404 from a lookup is still `null`,
  but a bad handle is now a `ValidationError`, a rate-limit refusal a `RateLimitedError`
  and a deployment that cannot answer an `UnavailableError`, instead of all of them
  reading as `null`. See [Errors](#errors-and-rate-limits).

`lookupWallet` now also finds a wallet linked from the CLI, not only the on-chain primary
binding. `listHandles` has no v1 endpoint and is deprecated (see below).

## Quickstart

The SDK talks to a Signet deployment. There is no hosted public deployment yet, so
`baseUrl` is a required option — point it at a local server:

```bash
git clone https://github.com/blockchain-maxis/signet && cd signet
pnpm install
pnpm --filter @signet/web dev     # http://localhost:3000
```

Then, in another terminal (`quickstart.ts`):

```ts
import { SignetClient, UnavailableError } from '@signet/sdk';

const signet = new SignetClient({ baseUrl: 'http://localhost:3000' });

const profile = await signet.getProfile('alice');
if (!profile) {
  console.log('alice is not on this deployment');
} else {
  console.log(profile.displayName ?? profile.handle);
  console.log(profile.primaryWallet); // 'G…', the on-chain bound account
  console.log(profile.counts); // { contracts, wallets, invocations }
}

try {
  console.log(await signet.countRegistryEntries()); // { count: … }
} catch (err) {
  if (err instanceof UnavailableError) console.log('the registry is not reachable');
  else throw err;
}
```

```bash
node --experimental-strip-types quickstart.ts
```

A deployment only knows the handles that are really bound: with the Identity Registry
configured (`NEXT_PUBLIC_IDENTITY_REGISTRY_ID`) it resolves them live from the chain, and
with `DATABASE_URL` set and the indexer running it serves indexed activity through the
same endpoints and the same response shapes. A local server with neither has no handles,
so `getProfile()` resolves to `null`.

## API reference

Everything below is exported from the package root.

### `new SignetClient(options)`

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `baseUrl` | `string` | *(required)* | Origin of a Signet deployment, e.g. `http://localhost:3000`. A trailing slash is stripped. The SDK appends `/api/v1/…` itself — don't include a path. |
| `apiKey` | `string` | none | A Signet API key (`sgk_…`), sent as `Authorization: Bearer`, for the keyed rate limit. Keep it server-side. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Override for tests, proxies, or runtimes without a global `fetch`. |
| `timeoutMs` | `number` | `10000` | Per-attempt timeout; a stalled attempt is aborted. |
| `maxRetries` | `number` | `2` | Retries after the first attempt, for 5xx, network failures and short rate limits (see below). `0` disables them. |

**Throws** `Error('[signet] no fetch implementation available; pass options.fetch')` from
the constructor when no `fetch` was passed and the runtime has no `globalThis.fetch`.

### `client.getProfile(handle)`

| | |
|--|--|
| **Returns** | `Promise<ProfileResponse \| null>`, the v1 `Profile`; `null` when there is no such handle. |
| **Requests** | `GET {baseUrl}/api/v1/profiles/{handle}` |

### `client.resolveHandle(handle)`

| | |
|--|--|
| **Returns** | `Promise<RegistryEntry \| null>` (`{ handle, wallet }`); `null` if the handle isn't bound. |
| **Requests** | `GET {baseUrl}/api/v1/resolve/{handle}` |

### `client.lookupWallet(wallet)`

| | |
|--|--|
| **Returns** | `Promise<RegistryEntry \| null>`; `null` if the wallet is not linked to a handle. |
| **Requests** | `GET {baseUrl}/api/v1/lookup/{wallet}` |

The reverse of `resolveHandle`: the handle a `G…` wallet is attributed to, whether it is
the on-chain bound wallet or one linked from the CLI. A `C…` contract ID is a
`ValidationError`.

### `client.countRegistryEntries()`

| | |
|--|--|
| **Returns** | `Promise<RegistryCount>` (`{ count }`); `0` when the registry could not be read. |
| **Requests** | `GET {baseUrl}/api/v1/registry/stats` |

The registry's own binding counter: an upper bound, not a live total, because a binding
that lapses from on-chain storage unaccessed is never subtracted.

### `client.request(path, { query })`

The transport the methods use, for any v1 endpoint: `GET {baseUrl}/api/v1{path}`, with
`query` as the query string (`undefined` and `null` values left out). Resolves to the
whole `{ data, meta }` envelope and throws the typed errors below.

```ts
const page = await signet.request('/profiles/alice/contracts', { query: { limit: 10 } });
```

### `client.listHandles()` *(deprecated)*

| | |
|--|--|
| **Returns** | `Promise<Handle[]>` |
| **Requests** | `GET {baseUrl}/api/trpc/profile.list` |

v1 has no endpoint that lists handles, so this still calls the web app's internal tRPC
route, which is not a stable contract. It will be removed in 1.0.

### Types

`ProfileResponse` and the other response types are generated from the v1 OpenAPI document
(`docs/api/openapi-v1.json`) into [`src/generated/v1.ts`](src/generated/v1.ts), so they
cannot drift from the API. `V1Data<'operationId'>` and `V1Meta<'operationId'>` give the
`data` and `meta` of any operation, and `V1Schemas` every component schema:

```ts
import type { V1Data, V1Schemas } from '@signet/sdk';

type Wallets = V1Data<'getHandleWallets'>; // HandleWallet[]
type Contract = V1Schemas['ProfileContract'];
```

`Handle`, `StellarAddress`, `RegistryEntry` and `RegistryCount` are re-exported from
`@signet/types`; see [`src/types.ts`](src/types.ts) for why the re-export is curated.

## Errors and rate limits

Every error extends `SignetError`. The ones the server answered with carry its `status`
and the v1 envelope's `code`:

| Class | When | Extra fields |
|--|--|--|
| `ValidationError` | `400`: a malformed handle, address, cursor or limit | `code`, `parameter` |
| `NotFoundError` | `404`, from `request()` (the named lookups return `null` instead) | `code` |
| `RateLimitedError` | `429` | `code`, `retryAfterSeconds` (from `Retry-After`, or `null`) |
| `UnavailableError` | `503`: no layer the deployment reads could answer | `code` |
| `ApiError` | any other non-OK status | `status`, `code` |
| `NetworkError` | the request never reached the server, or timed out | — |

Deployments rate-limit anonymous callers to **60 requests per minute per IP**, and API-key
callers to a higher budget (300 by default). When a `429`'s `Retry-After` is 5 seconds or
less and retries remain, the client waits it out and tries again; a longer wait surfaces
as `RateLimitedError` at once, so the caller can decide. `5xx` and network failures are
retried with exponential backoff (200 ms, 400 ms, … capped at 5 s). Other `4xx` are
answers and are never retried.

## Compatibility

- **Node.js 22+** — the package is ESM-only (`"type": "module"`) and relies on the global
  `fetch`. On older Node, pass `options.fetch` (e.g. `undici`). It currently ships
  TypeScript sources (`main`/`types` → `src/index.ts`), so a Node consumer needs a
  TypeScript-aware loader such as `node --experimental-strip-types`, `tsx`, or a bundler.
- **Browsers** — works in any browser with `fetch`. v1 sends
  `Access-Control-Allow-Origin: *`, so a cross-origin `baseUrl` works. Don't put an
  `apiKey` in browser code.
- **No runtime dependencies.** `@signet/types` is types-only and erases at build time.

## Testing against the SDK

`options.fetch` is the injection point — no network needed:

```ts
const client = new SignetClient({
  baseUrl: 'http://localhost:3000',
  fetch: async () => new Response(JSON.stringify({ data: fixtureProfile })),
});
```

See [`src/client.test.ts`](src/client.test.ts) for the full pattern. Run the suite with
`pnpm --filter @signet/sdk test`. After changing the API's OpenAPI document, regenerate the
types with `pnpm --filter @signet/sdk generate`.

## Links

- Repository: <https://github.com/blockchain-maxis/signet>
- API reference: [`docs/API_V1.md`](../../docs/API_V1.md) and the OpenAPI document at
  `/api/v1/openapi.json` on any deployment
- Architecture and data flows: [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
