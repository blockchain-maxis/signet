# Grant portal: verify an applicant

A runnable example of what Signet's v1 API is for. A grant applicant gives their Signet
handle and the address of the contract they say they built; the portal asks Signet whether
one of that handle's wallets deployed it, and shows the answer with the applicant's
wallets, their contracts and a Signet badge.

It is a small Node `http` server and one server-rendered HTML page, no framework and no
client script. The Signet calls happen server-side through
[`@signet/sdk`](../../packages/sdk), so an API key never reaches a browser.

## Run it

You need a Signet deployment to ask. Locally, from the repository root:

```bash
pnpm install
pnpm --filter @signet/web dev                         # Signet on http://localhost:3000
```

Then, in another terminal:

```bash
SIGNET_URL=http://localhost:3000 pnpm --filter grant-portal-example dev
# grant portal on http://localhost:4400, asking http://localhost:3000
```

Open <http://localhost:4400>, enter a handle and a contract address, and press Verify.
A local Signet without a database or Identity Registry configured knows no handles, so
every handle reads "No Signet profile"; point `SIGNET_URL` at a deployment with data to
see the other answers.

| Variable | Default | |
| --- | --- | --- |
| `SIGNET_URL` | `http://localhost:3000` | The Signet deployment to ask, also used for the badge and profile links. |
| `SIGNET_API_KEY` | none | Optional `sgk_…` key, sent as `Authorization: Bearer` for the higher keyed rate limit. |
| `PORT` | `4400` | Where the portal listens. |

For a production-style run, build and start the compiled server:

```bash
pnpm --filter @signet/sdk build
pnpm --filter grant-portal-example build
SIGNET_URL=https://signet.example pnpm --filter grant-portal-example start
```

## How it works

[`src/verify.ts`](src/verify.ts) is the whole integration:

1. `getProfile(handle)`: no profile means the applicant is not on Signet.
2. In parallel, `verifyDeployment(handle, address)`, `getWallets(handle)` and the first
   page of `listContracts(handle)`.
3. Every SDK error becomes something the page says, so an applicant is never told "not
   verified" when Signet could not check:

| SDK error | The page says |
| --- | --- |
| `ValidationError` | Check the handle or contract address, naming which. |
| `RateLimitedError` | Signet is limiting requests; try again in `retryAfterSeconds`. |
| `UnavailableError` | Signet could not check right now. This is not a verdict. |
| `NetworkError` | The portal could not reach Signet; check `SIGNET_URL`. |

The badge is an `<img>` of `/api/v1/badge/{handle}.svg?contract={address}`, which shows
the contract as deployed only when the same attribution check passes.

## Limitations

Be honest with reviewers about what a Signet answer is:

- **Testnet data only, today.** Signet deployments currently run on testnet. A verified
  badge names its network; a testnet result says nothing about mainnet.
- **`source: "cli"` wallets are an off-chain attestation.** A wallet linked from the
  Signet CLI is proven by a signed challenge the deployment checked and recorded, not by
  the on-chain registry. The page shows each wallet's source so a reviewer can weigh it.
- **Contract lists depend on the indexer.** A deployment whose indexer has not run (or
  has not caught up) knows fewer contracts; without a database Signet falls back to a
  capped walk of the primary wallet's Horizon history. The page says when the list is
  partial.
- **Factory deployments are not attributed.** A contract created by another contract on
  the applicant's behalf reads as "not verified".
- **Verified is not vetted.** Signet attests who deployed a contract, not its quality,
  safety or audit status.

## Tests

`pnpm --filter grant-portal-example test` runs [`src/verify.test.ts`](src/verify.test.ts)
against a fake SDK: verified, not attributed, unavailable and each other error, plus the
rendered page through the real server (escaping included). CI builds, typechecks, lints
and tests the example with the rest of the workspace.

It is a workspace package (`examples/*` in `pnpm-workspace.yaml`) rather than a
standalone project, so it always builds against the SDK in this repository and CI
catches an SDK change that breaks it.
