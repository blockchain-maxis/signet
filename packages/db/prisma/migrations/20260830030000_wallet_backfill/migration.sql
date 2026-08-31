-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "operationsCursor" TEXT,
ADD COLUMN     "operationsWatermark" TEXT,
ADD COLUMN     "backfillComplete" BOOLEAN NOT NULL DEFAULT false;
