-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "deploymentCursor" TEXT,
ADD COLUMN     "deploymentBackfilledAt" TIMESTAMP(3);
