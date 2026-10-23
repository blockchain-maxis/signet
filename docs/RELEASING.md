# Release Process & Versioning Policy

This document defines the release procedure, versioning semantics, and tagging conventions for the Signet repository (`blockchain-maxis/signet`).

---

## 1. Versioning Policy

Signet follows [Semantic Versioning (SemVer 2.0.0)](https://semver.org/spec/v2.0.0.html) across all packages and on-chain contracts: `MAJOR.MINOR.PATCH`.

```text
MAJOR (X.0.0) -> Breaking API changes, breaking contract storage layouts, or breaking schema migrations
MINOR (0.X.0) -> Backwards-compatible features, new API endpoints, non-breaking contract methods
PATCH (0.0.X) -> Backwards-compatible bug fixes, security patches, internal refactors
```

### Monorepo Scope Breakdown

| Component               | Scope                       | Version Reference                                 | Version Impact                                                                                          |
| ----------------------- | --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **`@signet/sdk`**       | External TypeScript SDK     | `packages/sdk/package.json`                       | Published to npm registry; breaking changes bump `MAJOR`                                                |
| **`identity-registry`** | Soroban Rust contract       | `packages/contracts/identity-registry/Cargo.toml` | On-chain bytecode deployed to permanent addresses; requires migration runbook if storage format changes |
| **`@signet/web`**       | Next.js frontend & tRPC API | `apps/web/package.json`                           | Web application deployment; tracks overall platform release                                             |
| **`@signet/indexer`**   | Ingestion worker            | `apps/indexer/package.json`                       | Background worker syncing events to Postgres                                                            |
| **`@signet/types`**     | Shared type definitions     | `packages/types/package.json`                     | Internal workspace dependency                                                                           |

---

## 2. Tagging Conventions

All releases are tracked via Git tags pushed to `main`:

- **Platform Releases**: `vX.Y.Z` (e.g. `v0.1.0`) — Tracks coordinated platform deployments.
- **CLI Releases**: `cli-vX.Y.Z` (e.g. `cli-v0.1.0`) — Tracks `signet` CLI and `signet-simulator` binary releases.
- **SDK Package Releases**: `sdk-vX.Y.Z` (e.g. `sdk-v0.1.0`) — Tracks npm releases of `@signet/sdk`.
- **Contract Releases**: `contract-vX.Y.Z` (e.g. `contract-v0.1.0`) — Tracks verified contract build hashes and on-chain deployment references.

---

## 3. Release Checklist & Step-by-Step Procedure

### Phase 1: Pre-Release Verification

Before tagging or releasing any component, verify that all CI gates and local suites pass cleanly:

```bash
# 1. Monorepo lint, typecheck, tests, and build
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# 2. Documentation and error consistency checks
node scripts/check-docs.mjs
node scripts/check-contract-errors.mjs

# 3. Contract unit tests and wasm size budget
cd packages/contracts
cargo test
stellar contract build
cd ../..
```

### Phase 2: Update Version Numbers & Changelog

1. Update version numbers in the target `package.json` or `Cargo.toml`.
2. Move unreleased changes in [`CHANGELOG.md`](../CHANGELOG.md) under a new dated release header `## [X.Y.Z] - YYYY-MM-DD`.
3. If a contract was deployed, record the contract ID and network in the Deployed Contract Registry table in [`CHANGELOG.md`](../CHANGELOG.md).
4. Commit the changes:
   ```bash
   git commit -m "chore(release): prepare vX.Y.Z release"
   ```

### Phase 3: Tagging & GitHub Release

Create an annotated Git tag and push it to the main repository:

```bash
# Tag the release
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z

# For SDK specific releases
git tag -a sdk-vX.Y.Z -m "Release @signet/sdk vX.Y.Z"
git push origin sdk-vX.Y.Z
```

Create a GitHub Release describing the changes and referencing the tag.

Pushing a `cli-vX.Y.Z` tag (or running `workflow_dispatch` against an existing one) runs `.github/workflows/release-cli.yml`:

1. The `simulator` job calls the reusable `.github/workflows/build-simulator.yml`, which builds `signet-simulator` natively (`cargo build --release --locked -p signet-simulator --target ...`, then strip and a `--version` check) on linux/x64, linux/arm64, darwin/arm64, darwin/x64 (cross-built on the arm64 runner) and windows/x64 runners, one `simulator-<platform>` artifact each. The Linux simulators are `*-unknown-linux-gnu` built on Ubuntu 24.04, so they need glibc 2.39 or newer; the Go binary is static and has no such floor.
2. The `release` job (`needs: simulator`) downloads those artifacts and runs `scripts/release/build-cli.sh` with `SIMULATOR_DIR` pointing at them. For each platform that cross-compiles `signet`, stages the npm package with both binaries side by side, and builds one archive, `signet-<version>-<platform>.tar.gz` (`.zip` on Windows), with `signet[.exe]` and `signet-simulator[.exe]` at the top level. A missing simulator fails the job.
3. `checksums.txt` covers the archives; the archives and `checksums.txt` are what the GitHub Release carries (the bare binaries are not uploaded).
4. `scripts/release/verify-artifacts.sh` checks that every platform package and every archive holds both binaries, that no archive is missing or left over, and that `checksums.txt` verifies. It runs before the GitHub Release and npm steps, so a partial release fails instead of publishing.
5. Publishing to GitHub Releases and npm is gated on `vars.CLI_RELEASE_ENABLED == 'true'`.

Every simulator job and the assembling `release` job run in the same workflow run at the same tag, which is what keeps "same release = same protocol version" true ([CLI_RUST_BRIDGE.md](./CLI_RUST_BRIDGE.md) section 5). Do not move the simulator build into a separate workflow or tag.

### Phase 4: Package & Contract Deployment

1. **Publishing `@signet/sdk`**:
   ```bash
   pnpm --filter @signet/sdk publish --access public
   ```
2. **Deploying / Upgrading Contracts**:
   - Follow the migration procedures in [`docs/CONTRACT_MIGRATION.md`](./CONTRACT_MIGRATION.md) and [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).
   - Verify on-chain contract initialization (`initialize(admin)`).
   - Update `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` in production environment variables.

### CLI release dry run

The real CLI release (`.github/workflows/release-cli.yml`, triggered by a `cli-v*.*.*` tag) is maintainer-only, so a broken `package.json`, shim or staging script would otherwise surface only while releasing. `.github/workflows/release-cli-dry-run.yml` rehearses it on every pull request that touches `cli/**`, `sandbox/**`, `scripts/release/**` or one of the release workflows, without publishing anything (read-only token, no `NPM_TOKEN`, no `production` environment, no GitHub Release).

- **Same steps as the release.** Both workflows run `scripts/release/build-cli.sh`, which cross-compiles every target, stages each `@signet/cli-<platform>` package with `signet` and `signet-simulator`, builds the per-platform archives, writes `cli/dist/checksums.txt` and pins the `@signet/cli` shim. Both also call `build-simulator.yml`, so the native simulator matrix has one definition, and both run `scripts/release/verify-artifacts.sh`, so the release and the rehearsal check the same invariant. The dry run uses the version `0.0.0-dryrun.<12-char head sha>`. Change the build in that script, not in a workflow, so the two cannot drift.
- **`simulator` job.** Builds the simulator on all five native runners, as the release does.
- **`build` job.** Lints the three release workflows with a pinned, checksum-verified `actionlint`, tests `scripts/release/stage-platform-package.mjs` with `node --test`, runs the build script with `SIMULATOR_DIR`, runs `verify-artifacts.sh` (both binaries in every platform package and archive, checksums verify), `npm pack`s every package under `cli/npm/` (the shim plus one per platform) and uploads the tarballs as the `cli-tarballs` artifact.
- **`install` job.** On ubuntu, macOS and Windows, installs the shim plus that OS's platform package from the tarballs into a temp directory (`npm install ./*.tgz`), then runs `signet-simulator --version` from the installed package's `bin/` directory (asserting it prints `signet-simulator`), and `npx signet --version` and `npx signet --help`. It asserts exit code 0 and that the `--version` output contains the dry-run version.

To reproduce the build locally (all targets, or a subset with `BUILD_ONLY`). Without `SIMULATOR_DIR` the script builds and stages `signet` only; to include the simulator, put a built one at `<dir>/simulator-<platform>/signet-simulator` and set `SIMULATOR_DIR=<dir>`:

```bash
VERSION=0.0.0-dryrun.local BUILD_ONLY="cli-linux-x64" scripts/release/build-cli.sh
git checkout -- cli/npm   # discard the staged binaries and pinned versions
```

What the dry run cannot show: it never creates a GitHub Release or publishes to npm, and it does not exercise `softprops/action-gh-release` or `npm publish --provenance`. A real `cli-v*.*.*` tag run (or `workflow_dispatch` on a fork test tag) is the only check of those.

Publishing is unchanged: only `release-cli.yml`, on a tag, and only when `vars.CLI_RELEASE_ENABLED == 'true'`.

---

## 4. Roles & Responsibilities

- **Who Tags & Publishes**: Releases may only be tagged and published by repository maintainers (`@blockchain-maxis`).
- **Review Requirements**: Pull requests modifying contracts, auth systems, or release workflows require approvals designated in `.github/CODEOWNERS`.
