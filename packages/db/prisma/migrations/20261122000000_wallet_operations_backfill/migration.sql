-- Backward-walk state for the operations worker, per wallet. Both columns are
-- nullable and left empty on purpose: a null cursor means the walk has not
-- started, so every existing wallet is walked once, from its newest operation
-- back to the retention cutoff. That is what picks up the history the first
-- 500-record scan left behind.
ALTER TABLE "Wallet" ADD COLUMN     "operationsCursor" TEXT,
ADD COLUMN     "operationsBackfilledAt" TIMESTAMP(3);
