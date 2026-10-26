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

### Contracts and verification

| Method | Requests | Returns |
|--|--|--|
| `listContracts(handle, { limit, cursor })` | `GET /api/v1/profiles/{handle}/contracts` | `{ data, meta }`: one page, newest deploy first |
| `getContract(handle, address)` | `GET /api/v1/profiles/{handle}/contracts/{address}` | the contract, or `null` unless one of the handle's wallets deployed it |
| `verifyDeployment(handle, address)` | the same | `{ verified, attribution? }` |
| `getContractSpec(address)` | `GET /api/v1/contracts/{address}/spec` | the embedded interface, or `null` |
| `getSpecByHash(wasmHash)` | `GET /api/v1/specs/{wasmHash}` | the interface, or `null` |

`verifyDeployment` is the grant-portal call: did this applicant's handle deploy the
contract they say they built? `attribution` says how Signet knows (`indexer`, or a
`deployer-check` over Horizon on a deployment without a database) and which of the
handle's wallets deployed it. A contract another handle deployed and one that does not
exist are both `{ verified: false }`. When the deployment could not check at all, the call
throws `UnavailableError` rather than answering "not verified".

```ts
const { verified, attribution } = await signet.verifyDeployment('alice', 'CA…');
```

### Wallets, operations, lookup, stats, health

| Method | Requests | Returns |
|--|--|--|
| `getWallets(handle)` | `GET /api/v1/profiles/{handle}/wallets` | every linked wallet, primary first, or `null` |
| `listOperations(handle, { limit, cursor })` | `GET /api/v1/profiles/{handle}/operations` | `{ data, meta }`: one page |
| `lookupAddress(address)` | `GET /api/v1/lookup/{address}` | `{ address, handle, source, isPrimary, network }` (`handle` null when unlinked) |
| `getRegistryStats()` | `GET /api/v1/registry/stats` | `{ boundHandles, indexedContracts, indexedWallets, network }` |
| `getHealth()` | `GET /api/v1/health` | the deployment's health checks |

### Iterating every page

`iterateContracts(handle)` and `iterateOperations(handle)` are `AsyncIterable`s that
follow `meta.nextCursor` until the list ends (`{ pageSize }` sets the page size):

```ts
const contracts = signet.iterateContracts('alice');
for await (const c of contracts) console.log(c.address);
if (contracts.truncated) console.log('the deployment could only list part of them');
```

A list the deployment can only give in part (a capped Horizon walk, or no layer able to
enumerate) ends early **by design**: `truncated` is `null` while iterating and, once done,
`true` when the list was partial. Reading the iterator by hand, the final result is
`{ done: true, value: { truncated } }`.

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

- **Node.js 22+** — ESM only (`"type": "module"`), built to `dist/` as JavaScript with
  `.d.ts` declarations, so no TypeScript loader is needed. It relies on the global
  `fetch`; on older Node, pass `options.fetch` (e.g. `undici`).
- **Browsers** — bundlers pick the `browser` export, `dist/browser/signet.min.js`: one
  minified ES module with no Node built-ins, about 2 kB gzipped (CI fails it over 12 kB).
  Without a bundler, import it directly:

  ```html
  <script type="module">
    import { SignetClient } from '/vendor/signet.min.js';
    const health = await new SignetClient({ baseUrl: 'https://signet.example' }).getHealth();
  </script>
  ```

  v1 sends `Access-Control-Allow-Origin: *`, so a cross-origin `baseUrl` works. Don't put
  an `apiKey` in browser code.
- **No runtime dependencies.**
- **Inside this monorepo** the `development` export condition points at `src/`
  (`customConditions` in `tsconfig.base.json`), so workspaces typecheck against the
  sources without building first.

Building: `pnpm --filter @signet/sdk build` writes `dist/`. `smoke:node`, `check:size`,
`check:pack` (what `npm pack` would publish) and `test:browser` (the bundle in Chromium)
check it; CI runs all four.

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
