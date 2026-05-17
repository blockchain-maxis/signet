# Next steps

This repo is currently scaffolding only. Work for the next pass, in priority
order:

1. **Implement the `identity-registry` Soroban contract.** Replace the
   hello-world stub in `packages/contracts/identity-registry/src/lib.rs` with
   the real binding logic + signature verification (wallet → handle
   attestations, signed binding payload, read methods for the indexer).

2. **Expand the Prisma schema.** Grow `packages/db/prisma/schema.prisma`
   beyond the placeholder `Profile` to model wallets, contracts,
   attestations, and activity snapshots; add the first real migration.

3. **Wire up Stellar Wallets Kit for wallet connect.** Flesh out
   `apps/web/lib/wallet.ts` (network from `STELLAR_NETWORK`, module list,
   connect/disconnect/sign helpers, persistence) and a dashboard entry point.

4. **Build the on-chain attestation flow end-to-end.** Sign the binding
   payload in the dashboard, submit to `identity-registry`, and verify.

5. **Build the indexer's deployment-detection worker.** Implement
   `apps/indexer/src/workers/deployment.ts` (+ `horizon.ts` / `soroban-rpc.ts`
   / `db.ts`) to discover contract deployments for linked wallets.

6. **Build the public profile page UI.** Replace the placeholders under
   `apps/web/app/(profile)/profile/[handle]` with the real profile and
   per-contract activity views.

7. **Build the demo external integration.** A simple "Verified by Signet"
   badge snippet powered by `@signet/sdk`.

## Scaffolding notes / deviations

- **Route groups vs. the spec tree.** Next.js route groups (`(marketing)`,
  `(dashboard)`, …) are invisible in the URL, so three groups each owning a
  root `page.tsx` would all resolve to `/` and fail the build with a
  "parallel pages" error. To keep the app buildable while preserving the
  middleware's documented path scheme, each non-marketing group's pages live
  under a real path segment: `(dashboard)/app/*`, `(docs)/docs/*`,
  `(profile)/profile/[handle]/*`. Marketing keeps `/`. The middleware rewrites
  subdomains to these internal paths. Revisit if the routing model changes.
- A root `apps/web/app/layout.tsx` (html/body + global CSS) was added in
  addition to the per-group layouts so every route has a valid root layout.
- `@signet/db` re-exports `@prisma/client`; the client is generated on
  `postinstall` (and `pnpm db:generate`). Typecheck depends on that having
  run.
