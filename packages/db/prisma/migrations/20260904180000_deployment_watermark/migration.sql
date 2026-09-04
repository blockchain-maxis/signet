-- Forward progress for the deployment worker once a wallet's backward
-- backfill has finished. Nullable and un-backfilled on purpose: a null
-- watermark means "no forward position yet", and the worker falls back to the
-- bounded newest-first window for that one tick, which is exactly the previous
-- behaviour. It picks up a real watermark from that tick onwards.
ALTER TABLE "Wallet" ADD COLUMN "deploymentWatermark" TEXT;
