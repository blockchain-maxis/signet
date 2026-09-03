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
cargo build --target wasm32v1-none --release
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

### Phase 4: Package & Contract Deployment

1. **Publishing `@signet/sdk`**:
   ```bash
   pnpm --filter @signet/sdk publish --access public
   ```
2. **Deploying / Upgrading Contracts**:
   - Follow the migration procedures in [`docs/CONTRACT_MIGRATION.md`](./CONTRACT_MIGRATION.md) and [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).
   - Verify on-chain contract initialization (`initialize(admin)`).
   - Update `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` in production environment variables.

---

## 4. Roles & Responsibilities

- **Who Tags & Publishes**: Releases may only be tagged and published by repository maintainers (`@blockchain-maxis`).
- **Review Requirements**: Pull requests modifying contracts, auth systems, or release workflows require approvals designated in `.github/CODEOWNERS`.
