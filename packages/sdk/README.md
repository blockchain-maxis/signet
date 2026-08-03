# @signet/sdk

Read-only TypeScript client for the [Signet](https://github.com/blockchain-maxis/signet)
API. Signet is a verifiable developer career record built on Stellar/Soroban: developers
bind a deployment wallet to a handle on-chain, an indexer collects everything that wallet
has deployed and invoked, and the result is served as a public profile. This SDK fetches
those profiles over plain HTTP GET so an integrator can render someone's contract history
without running a Signet deployment, speaking tRPC, or adding a client library.

## Install

```bash
pnpm add @signet/sdk      # npm install @signet/sdk / yarn add @signet/sdk
```

> **Not on npm yet.** `packages/sdk` is still `"private": true` inside this monorepo and
> is consumed as `"@signet/sdk": "workspace:*"`. Publishing is tracked in
> [#60](https://github.com/blockchain-maxis/signet/issues/60); until it lands, use the
> workspace dependency or a git dependency on this repo.

## Quickstart

The SDK talks to a Signet deployment. There is no hosted public deployment yet — the
default `baseUrl` (`https://signet.dev`) does **not** currently serve the API — so point
it at a local server:

```bash
git clone https://github.com/blockchain-maxis/signet && cd signet
pnpm install
pnpm --filter @signet/web dev     # http://localhost:3000, no database required
```

Then, in another terminal (`quickstart.ts`):

```ts
import { SignetClient } from '@signet/sdk';

const signet = new SignetClient({ baseUrl: 'http://localhost:3000' });

const handles = await signet.listHandles();
console.log(handles); // [ 'aquawolf', 'sorobuilder', 'stellardev' ]

const profile = await signet.getProfile('aquawolf');
if (!profile) throw new Error('handle not found');

console.log(profile.profile.name); // 'Aqua Wolf'
console.log(profile.profile.wallet); // 'GASAAEJC…' — the bound Stellar account
console.log(profile.stats); // { invocations, uniqueFunctions, reputation }
```

```bash
node --experimental-strip-types quickstart.ts
```

The demo handles above are served from static testnet fixtures with **synthetic** data.
A deployment with `DATABASE_URL` set and the indexer running serves real indexed activity
through the same procedures and the same response shapes.

## API reference

Everything below is exported from the package root.

### `new SignetClient(options?)`

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `baseUrl` | `string` | `'https://signet.dev'` | Origin of a Signet deployment. A trailing slash is stripped, so `https://x.dev/` and `https://x.dev` behave identically. The SDK appends `/api/trpc/…` itself — don't include a path. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Override for tests, proxies, or runtimes without a global `fetch`. |

**Throws** `Error('[signet] no fetch implementation available; pass options.fetch')` from
the constructor when no `fetch` was passed and the runtime has no `globalThis.fetch`
(Node 17 and older). This is the only error the SDK throws on its own.

```ts
const signet = new SignetClient({
  baseUrl: 'https://signet.example.com',
  fetch: myInstrumentedFetch,
});
```

### `client.getProfile(handle)`

| | |
|--|--|
| **Parameters** | `handle: Handle` (`string`) — must match `/^[a-z0-9_-]{1,32}$/`; the server lowercases before validating. |
| **Returns** | `Promise<ProfileResponse \| null>` |
| **Requests** | `GET {baseUrl}/api/trpc/profile.byHandle?input={"handle":"…"}` |

Resolves to `null` — never throws — when the handle is unknown, when the handle fails
server-side validation, when the response status is not 2xx (including a rate-limit
rejection), and when the tRPC envelope carries no `result.data`. If you need to tell
"not found" apart from "the deployment is down", check the deployment's `/api/health`
endpoint separately.

```ts
const res = await signet.getProfile('aquawolf');
// {
//   handle: 'aquawolf',
//   profile: { handle, name, bio, wallet, joined },
//   stats:   { invocations, uniqueFunctions, reputation },
// }
```

> The server also returns a raw `operations` array alongside these fields. It is
> deliberately **not** part of `ProfileResponse` — its shape is a Horizon payload that is
> not yet a stable public contract, so don't rely on it through the SDK's types.

### `client.listHandles()`

| | |
|--|--|
| **Parameters** | none |
| **Returns** | `Promise<Handle[]>` — `[]` on any failure, never `null`, never throws. |
| **Requests** | `GET {baseUrl}/api/trpc/profile.list` |

Lists every handle the deployment can serve: the curated static manifest, or the
on-chain-bound handles once a database is configured.

### Types

Re-exported from `@signet/types`, so integrators depend on `@signet/sdk` alone.

```ts
type Handle = string;
/** A Stellar account or contract address (G… / C…). */
type StellarAddress = string;

interface SignetProfile {
  handle: Handle;
  name: string;
  bio: string;
  wallet: StellarAddress; // the on-chain-bound Stellar account
  joined: string;
}

interface ProfileStats {
  invocations: number;
  uniqueFunctions: number;
  reputation: number; // 0–100 heuristic score derived from observed activity
}

interface ProfileResponse {
  handle: Handle;
  profile: SignetProfile;
  stats: ProfileStats;
}

interface SignetClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

const SIGNET_TYPES_VERSION: string; // '0.1.0'
```

## Errors and rate limits

The client is intentionally total: every method resolves to a value (`null` / `[]`)
rather than rejecting, so a dead deployment degrades a page instead of crashing it.
Network-level failures from the underlying `fetch` (DNS, TLS, aborted request) still
reject — wrap calls in `try`/`catch` if you need to handle those.

Deployments rate-limit each caller IP to **60 requests per minute per procedure**
(fixed window, in-memory per instance). Over the limit the API responds with an error
status, which the SDK surfaces as `null` / `[]` — indistinguishable from "not found", so
cache results client-side rather than fetching per render.

## Compatibility

- **Node.js 22+** — the package is ESM-only (`"type": "module"`) and relies on the global
  `fetch`. On older Node, pass `options.fetch` (e.g. `undici`). It currently ships
  TypeScript sources (`main`/`types` → `src/index.ts`), so a Node consumer needs a
  TypeScript-aware loader such as `node --experimental-strip-types`, `tsx`, or a bundler.
- **Browsers** — works in any browser with `fetch`. Requests are same-origin-agnostic
  plain `GET`s, so a cross-origin `baseUrl` needs CORS enabled on that deployment.
- **No runtime dependencies.** The only dependency, `@signet/types`, is types-only and
  erases at build time.

## Testing against the SDK

`options.fetch` is the injection point — no network needed:

```ts
const client = new SignetClient({
  baseUrl: 'https://signet.dev',
  fetch: async () => ({ ok: true, json: async () => ({ result: { data: fixture } }) }) as Response,
});
```

See [`src/client.test.ts`](src/client.test.ts) for the full pattern. Run the suite with
`pnpm --filter @signet/sdk test`.

## Links

- Repository: <https://github.com/blockchain-maxis/signet>
- Architecture and data flows: [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- API surface (tRPC router): [`apps/web/lib/server/trpc.ts`](../../apps/web/lib/server/trpc.ts)
