# Contributing to Signet

Thanks for your interest in Signet — a verifiable developer career record built
on Stellar/Soroban. This guide covers local setup, the checks your change must
pass, commit conventions, and how issue points work.

## Prerequisites

- **Node 22+**
- **pnpm 9** (`packageManager` is pinned to `pnpm@9.12.0`; `corepack enable` will
  use the right version automatically)
- **Rust** with the `wasm32v1-none` target — only if you touch the Soroban
  contracts under `packages/contracts` (`rustup target add wasm32v1-none`)
- **Docker** — only if you run the indexer or the database locally

## Setup

```bash
git clone https://github.com/blockchain-maxis/signet.git && cd signet
pnpm install

# Run just the web app (no database needed for the demo routes)
pnpm --filter @signet/web dev
```

Visit `http://localhost:3000`.

The database and indexer are optional for most web work — the demo profiles
render from static JSON. If you do need them:

```bash
pnpm db:up        # start Postgres via infra/docker/docker-compose.yml
pnpm db:migrate   # apply migrations
pnpm indexer:dev  # run the indexer
```

## The gates

CI runs the same commands you can run locally. **Every one must pass before a PR
is merged.** Prefer scoping to the package you changed for a faster loop.

| Gate | Whole repo | Just the web app |
|------|-----------|------------------|
| Lint | `pnpm lint` | `pnpm --filter @signet/web lint` |
| Typecheck | `pnpm typecheck` | `pnpm --filter @signet/web typecheck` |
| Test | `pnpm test` | `pnpm --filter @signet/web test` |
| Build | `pnpm build` | `pnpm --filter @signet/web build` |

**Soroban contracts** (`packages/contracts`) have a separate CI job — run it
locally when you touch Rust:

```bash
cd packages/contracts
cargo test
cargo build --target wasm32v1-none --release
```

CI also enforces a **wasm size budget** (20 KB for `identity_registry`). If a
size increase is expected and justified, bump `BUDGET_BYTES` in
`.github/workflows/ci.yml` in the same PR and explain why.

> A repo-wide `pnpm format` (Prettier) is available for convenience, but
> formatting is **not** a CI gate — don't reformat files you didn't otherwise
> change, as it adds noise to reviews.

## Commit style

Signet uses [Conventional Commits](https://www.conventionalcommits.org/) with an
**area scope** matching the repo's `area:` labels:

```
<type>(<scope>): <subject>
```

- **type** — `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`
- **scope** — `web`, `indexer`, `contract`, `sdk`, `infra` (omit for repo-wide
  changes)

Examples:

```
feat(web): add on-chain handle fallback to the wallets page
fix(indexer): make the operations worker idempotent
docs: add contributor onboarding files
```

Keep the subject imperative and under ~72 characters. Reference the issue in the
PR body with `Closes #<n>`.

## Pull requests

1. Branch off `main` (`<type>/<short-description>`).
2. Make focused changes — one issue per PR.
3. Run the gates above locally.
4. Open the PR against `main`, fill in the template, and link the issue with
   `Closes #<n>`.
5. If your issue was assigned to you, confirm it's still assigned to you before
   opening the PR.

## Issue points

Issues carry a `points:` label that reflects their scope and reward:

| Label | Points | Rough scope |
|-------|-------:|-------------|
| `points: trivial` | 100 | Docs, small config, a self-contained helper |
| `points: medium` | 150 | A feature or fix spanning a few files, with tests |
| `points: high` | 200 | Cross-cutting or security-sensitive work |

Look for **`good first issue`** if you're new. Comment to get assigned before
starting, so work isn't duplicated.

## Reporting bugs & requesting features

Use the issue templates under **New issue** — `Bug report` or `Feature request`.
Security issues should follow [`SECURITY.md`](SECURITY.md) instead of a public
issue.
