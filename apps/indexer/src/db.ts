// TODO(signet): instantiate and export a shared PrismaClient from @signet/db
// and provide helpers for upserting profiles, contracts, and snapshots.

export function getDb(): never {
  throw new Error('[indexer] db.ts is a stub — wire up @signet/db in the next pass');
}
