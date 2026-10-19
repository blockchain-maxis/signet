# Contributing to Signet

Thanks for your interest in Signet — a verifiable developer career record built
on Stellar/Soroban. This guide covers local setup, the checks your change must
pass, commit conventions, and how issue points work.

## Prerequisites

- **Node 22+**
- **pnpm 9** (`packageManager` is pinned to `pnpm@9.12.0`; `corepack enable` will
  use the right version automatically)
- **Go** (version pinned in `cli/go.mod`) — only if you touch the `signet` CLI
  under `cli/`; [`golangci-lint`](https://golangci-lint.run/usage/install/) too,
  if you want to run its lint gate locally rather than waiting for CI
- **Rust** with the `wasm32v1-none` target — only if you touch the Soroban
  contracts under `packages/contracts` (`rustup target add wasm32v1-none`)
- **Rust** (stable; `sandbox/rust-toolchain.toml` pins the exact version and
  `rustup` installs it) — only if you touch the contract simulator under
  `sandbox/`. `make test` skips the sandbox tests, with a one-line notice, when
  `cargo` is not installed
- **Docker** — only if you run the indexer or the database locally

## Setup

```bash
git clone https://github.com/blockchain-maxis/signet.git && cd signet
pnpm install

# Run just the web app (no database needed)
pnpm --filter @signet/web dev
```

Visit `http://localhost:3000`.

The database and indexer are optional for most web work — profiles fall back
to live chain (`resolve`) and Horizon reads when no `DATABASE_URL` is set. Set
`NEXT_PUBLIC_IDENTITY_REGISTRY_ID` in `.env` to see real handles; without it,
`/handles` is empty and says why. If you do need the database and indexer:

```bash
pnpm db:up        # start Postgres via infra/docker/docker-compose.yml
pnpm db:migrate   # apply migrations
pnpm indexer:dev  # run the indexer
```

### Local stack

To run Postgres and the indexer together in a single local Docker stack:

```bash
pnpm stack:up     # build and start Postgres + indexer containers
pnpm stack:down   # stop the stack
```

### Seeding local data from testnet

Synthetic demo profiles are not seeded into fresh databases. To seed a real on-chain claim into your local database:

1. Deploy any contract to testnet with the `stellar` CLI.
2. Claim a handle at `/claim` on testnet.
3. Run:
   ```bash
   pnpm dev:seed --handle <your-handle>
   ```
This reads the real on-chain claim binding from testnet, persists the profile and wallet in your local database with `indexRequestedAt` set, and triggers the running indexer to scan it promptly.

### Running e2e with the fixture database

The default `e2e` run is hermetic (no database). Specs that need Postgres put `@db` in their `describe` title: CI runs them in the `e2e-linked` CI job (`playwright test --grep @db`) and skips them in `e2e` (`--grep-invert @db`), so each spec runs in one lane. `apps/web/e2e/fixtures/contracts.ts` provides the contract-page fixture (this is test-only data, loaded by Playwright's `globalSetup` when `DATABASE_URL` is set). Locally:

```bash
pnpm db:up
pnpm db:migrate
DATABASE_URL=postgresql://... pnpm --filter @signet/web test:e2e
```

Without `DATABASE_URL` these specs are skipped, not failed. State that the fixture is test-only data.

## The gates

CI runs the same commands you can run locally. **Every one must pass before a PR
is merged.** Prefer scoping to the package you changed for a faster loop.

| Gate | Whole repo | Just the web app | Sandbox crate |
|------|-----------|------------------|---------------|
| Lint | `pnpm lint` | `pnpm --filter @signet/web lint` | `cargo clippy --locked --manifest-path sandbox/Cargo.toml -- -D warnings` |
| Typecheck | `pnpm typecheck` | `pnpm --filter @signet/web typecheck` | — |
| Test | `pnpm test` | `pnpm --filter @signet/web test` | `cargo test --locked --manifest-path sandbox/Cargo.toml` |
| Build | `pnpm build` | `pnpm --filter @signet/web build` | `cargo build --release --locked --manifest-path sandbox/Cargo.toml` |
| Format check | `make check-fmt` | — | `cargo fmt --all --check --manifest-path sandbox/Cargo.toml` |

Those `pnpm` commands only cover the TypeScript workspace. **The CLI (`cli/`,
Go) and the sandbox simulator (`sandbox/`, Rust) have their own CI jobs.** The root
`Makefile` is the one entrypoint that covers them, so a contributor who runs it
cannot skip a toolchain by not knowing about it:

```bash
make build       # ts-build + go-build + sandbox-build
make test        # ts-test + go-test + sandbox-test
make lint        # ts-lint + go-lint (needs golangci-lint on PATH) + sandbox-lint
make fmt         # gofmt -w cli/
make check-fmt   # fails if cli/ or sandbox/ isn't formatted, without rewriting anything
```

`pnpm build:all` / `test:all` / `lint:all` / `fmt` / `check-fmt` delegate to the
same targets, so existing muscle memory still works.

**Sandbox crate** (`sandbox/`) can also be checked directly with cargo:

```bash
cargo fmt --all --check --manifest-path sandbox/Cargo.toml
cargo clippy --locked --manifest-path sandbox/Cargo.toml -- -D warnings
cargo test --locked --manifest-path sandbox/Cargo.toml
```

**Soroban contracts** (`packages/contracts`) have a separate CI job — run it
locally when you touch Rust:

```bash
cd packages/contracts
cargo test
stellar contract build
```

### Bumping a budget

- **Wasm size budget**: CI enforces a wasm size budget (20 KB for `identity_registry`). If a size increase is expected and justified, bump `BUDGET_BYTES` in `.github/workflows/ci.yml` in the same PR and explain why.
- **Route JS budget**: CI enforces a first-load JS budget on the contract page via `scripts/check-route-budgets.mjs` (#661). A route's budget is its measured gzip first-load JS plus 10%; if a route legitimately grows, bump its byte budget in `scripts/check-route-budgets.mjs` in the same PR and explain why. Prefer splitting heavy client code so each tab only loads what it renders.
- **Accessibility budget / violations**: Automated accessibility checks (#659) run via Playwright in `apps/web/e2e/a11y.spec.ts`. Accepted exceptions must be listed by rule id in `knownViolations` (see `apps/web/e2e/a11y.ts`), each citing the issue tracking its fix. That list must not grow without review.

### Adding a spec fixture

Spec reader fixture WASMs live under `packages/spec/fixtures/`. Network captures are fetched from testnet using `packages/spec/scripts/fetch-fixture.ts` and recorded in `packages/spec/fixtures/manifest.json`. Locally-built fixtures are built from source under `packages/spec/fixture-contracts/`. To regenerate and verify them:

```bash
# Rebuild the committed fixture WASMs in place:
bash packages/spec/fixture-contracts/build-fixtures.sh

# Verify without writing (what the spec-fixtures CI job runs):
bash packages/spec/fixture-contracts/build-fixtures.sh --check
```

> A repo-wide `pnpm format` (Prettier) is available for convenience, but
> formatting is **not** a CI gate — don't reformat files you didn't otherwise
> change, as it adds noise to reviews.

## Area labels

When opening or categorising issues and PRs, use the appropriate `area:` label:

- `area: sandbox`: Local sandbox simulator (`sandbox/`), native host runtime, and CLI simulation.
- `area: visualiser`: Contract diagram package (`packages/visualiser`) and interactive diagram components.
- `area: api`: Public REST API `/api/v1` (`apps/web/app/api/v1`) and its OpenAPI 3.1 specification.
- `area: docs-gen`: Shared spec reader (`packages/spec`) and generated contract documentation/client stubs.

## API surfaces

New public reads go into `/api/v1` (see [`docs/API_V1.md`](docs/API_V1.md)) — not tRPC and not `/api/cli/*`, which are internal and change with the app.

## Commit style

Signet uses [Conventional Commits](https://www.conventionalcommits.org/) with an
**area scope** matching the repo's `area:` labels:

```
<type>(<scope>): <subject>
```

- **type** — `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`
- **scope** — `web`, `indexer`, `contract`, `sdk`, `infra`, `cli`, `sandbox`, `visualiser`, `api`, `spec` (omit for repo-wide
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

Look for **`good first issue`** if you're new. Comment to get assigned before
starting, so work isn't duplicated.

## Reporting bugs & requesting features

Use the issue templates under **New issue** — `Bug report` or `Feature request`.
Security issues should follow [`SECURITY.md`](SECURITY.md) instead of a public
issue.
