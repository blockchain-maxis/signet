# Design note: linking a GitHub account (roadmap, not scheduled work)

> **Status: direction, not implementation.** This is a design note for
> [#295](https://github.com/blockchain-maxis/signet/issues/295), tagged
> `roadmap`. No code in this repository implements any part of it. It
> deliberately follows terminal (CLI) linking — see
> [`REGISTRY_INTEGRATION.md`](REGISTRY_INTEGRATION.md) for the wallet-binding
> flow this builds on — and should not be started before that ships.

## 1. The problem

Deploy-wallet linking builds a career record out of
`HostFunctionTypeCreateContract` operations. That captures contract authors and
misses everyone else who builds on Stellar: frontend developers, SDK and
tooling maintainers, docs and infrastructure contributors — none of whom
deploy a contract, all of whom have a real, verifiable record of work.

A "verifiable developer career record" that can only see contract deployers is
a partial record of the ecosystem. Linking a GitHub account broadens who the
record — and the product — can see, without touching what already works for
deployers.

## 2. Proof of account control

The wallet-linking flow already establishes the pattern this should follow:
prove control of an external identity via a signed, single-use, time-bounded
challenge, rather than trusting a bare claim.

For GitHub, the equivalent proof is **OAuth authorization**, not a signed
message — GitHub is the identity provider here, and Signet has no key of the
account holder's to ask them to sign with. The proposed flow:

1. The signed-in Signet session (already proven via Sign-In With Stellar)
   initiates a standard OAuth Authorization Code flow against GitHub, scoped
   to `read:user` only — no repo, org, or write access. Signet does not need
   to act as the GitHub account; it only needs to know *whose* account it is
   linking to.
2. GitHub redirects back with a code; Signet's server exchanges it for an
   access token, calls `GET /user` to resolve the account's immutable numeric
   id and login, and discards the token immediately after — it is not needed
   again unless attribution (§3) requires a second, narrower-scoped call at
   link time.
3. The link is recorded against the **numeric GitHub user id**, never the
   login alone: a login can be renamed and reused by a different account
   later, and a career record binding to a reusable name would eventually
   attribute someone else's later activity under that name to the original
   claimant.
4. Same trust rules as terminal linking: single-use authorization code
   (enforced by GitHub itself), a state parameter is verified against a
   server-issued nonce to prevent CSRF, and re-linking a GitHub account
   already bound to a *different* Signet profile is a typed conflict, not a
   silent takeover — mirroring `WalletAlreadyLinkedError` in
   `apps/web/lib/server/account.ts`.

This is **weaker proof than a wallet signature**: it establishes "this GitHub
account authorized Signet to know its identity," backed by GitHub's own
authentication (including 2FA, if the account has it) — not "this person
controls a private key," which is a categorically stronger, cryptographic
claim. §4 makes sure the rendered profile never blurs that distinction.

## 3. What is attributed

**Stellar-ecosystem contributions, not all public GitHub activity.** Signet is
a Stellar career record, not a general-purpose GitHub profile aggregator —
attributing someone's unrelated open-source work would dilute the specific
signal the product exists to provide, and it's a much larger, fuzzier surface
to get right (what counts as "real" contribution? how is spam or low-effort
activity filtered?).

Concretely, scope attribution to a **maintained allowlist of Stellar-ecosystem
organizations and repositories** (Stellar Development Foundation, Soroban,
this repo, and similarly-curated others), and within that scope, to durable,
reviewed signals rather than raw event volume:

- merged pull requests (not just opened ones — a merged PR reflects a
  maintainer's review, not just an attempt)
- authored commits reachable from a default branch (catches direct-push
  contributors on repos without required PR review)

Explicitly **not**: issue comments, stars, forks, or activity on repos outside
the allowlist. These are easy to inflate and weak signals of real
contribution — the opposite of what a *verifiable* record needs.

The allowlist itself is a curation/maintenance cost this note does not solve —
it needs an owner and a process (likely: a config file in this repo, PR-gated
like any other change) before implementation, not just at launch.

## 4. Rendering: adjacent, never equivalent

The two record types carry fundamentally different trust levels, and the
profile must never let them blur together:

- **On-chain deployments** are independently verifiable by anyone, with no
  reliance on Signet or GitHub being honest or even online — the claim is
  "this Stellar account executed this operation," provable directly against
  Horizon/the ledger.
- **GitHub contributions** are only as trustworthy as GitHub's API and
  Signet's own database — verifiable by a third party only by separately
  querying GitHub themselves, not by an independent chain read.

Concretely:

- A **separate section** on the profile page (`apps/web/app/p/[handle]/page.tsx`),
  visually distinct from "On-chain activity" — not merged into the same stat
  row or list, and not counted into `computeStats`'s reputation number (see
  `apps/web/lib/profiles.ts`) without a very deliberate, separately-labeled
  decision to do so later.
- Every GitHub-derived line item is labeled with its provenance (e.g. "via
  GitHub" or a small GitHub mark) and links to the actual PR/commit on
  GitHub, so a viewer can check the underlying claim independently — the
  same principle `getOperations`'s Stellar Expert links already follow for
  on-chain data.
- Copy near the section states plainly that this reflects GitHub's account
  linking, not a cryptographic proof — matching the existing demo/on-chain
  provenance framing pattern on the profile page (`isDemo` vs. bound-on-chain
  badges already do exactly this kind of "make the reader ask the right
  question" labeling).

## 5. Data model

**A sibling identity table, not a field on `Wallet`.** `Wallet` rows model
proof of a *Stellar key* — `pubkey`, `attestedAt`, `source`,
`indexRequestedAt` are all wallet/key-specific concepts that make no sense
for a GitHub account (a GitHub link has no public key, no Horizon operations,
nothing for the deployment/operations workers to scan). Overloading `Wallet`
with an optional "this row is actually a GitHub identity" mode would make
every query and worker that touches `Wallet` need to branch on which kind of
row it's looking at.

Proposed shape (illustrative — not a finished schema, since this is a design
note, not an implementation):

```prisma
model GithubIdentity {
  id            String   @id @default(cuid())
  profileId     String
  githubUserId  Int      @unique   // GitHub's numeric id — see §2.3
  githubLogin   String             // display only; not the join key
  linkedAt      DateTime @default(now())

  profile       Profile  @relation(fields: [profileId], references: [id], onDelete: Cascade)

  @@index([profileId])
}
```

`Profile` gains a `githubIdentities GithubIdentity[]` relation, mirroring
`wallets Wallet[]` — a profile can plausibly have more than one wallet
already (this is exactly what deploy-wallet linking added), and there's no
reason to assume exactly one GitHub account either, though a single primary
link is likely the common case and all the UI needs to start.

A **new worker** (not `deployment`/`activity`/`operations`, which are all
Horizon-shaped) would periodically resolve each linked identity's PRs/commits
within the allowlisted repos via the GitHub API and populate a further
`GithubContribution`-shaped table — left for the implementation issue, since
the polling cadence, GitHub API rate-limit handling, and pagination strategy
are exactly the kind of concrete engineering decisions this design note is
scoped to leave open.

## 6. Explicitly out of scope here

- OAuth app registration, client secret storage/rotation, and the actual
  callback route implementation.
- The allowlist's initial contents and its maintenance process.
- Whether/how GitHub contributions ever factor into the `reputation` score.
- Any UI beyond the rendering *principle* in §4 — no mockups, no final copy.

These are implementation-issue concerns. This note's job is only to settle
the four questions #295 asked for: proof of control, attribution scope,
rendering trust boundary, and data model shape — so that whichever issue
picks up the implementation isn't re-litigating them from scratch.
