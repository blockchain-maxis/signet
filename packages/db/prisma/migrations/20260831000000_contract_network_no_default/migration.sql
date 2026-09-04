-- Backfill: no writer sets Contract.network to anything but the indexer's
-- configured network today, and the only Identity Registry deployed so far is
-- on testnet — so any row that silently took the old "mainnet" schema
-- default (rather than an explicit write) is mislabeled. Since this project
-- has not deployed a mainnet registry yet, "mainnet" here can only ever be
-- the stale default, never a real deployment.
UPDATE "Contract" SET "network" = 'testnet' WHERE "network" = 'mainnet';

-- AlterTable: drop the default so a future writer that forgets to pass
-- `network` fails loudly (a NOT NULL violation) instead of silently
-- mislabeling a deployment.
ALTER TABLE "Contract" ALTER COLUMN "network" DROP DEFAULT;
