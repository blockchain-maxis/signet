-- AlterTable
ALTER TABLE "Operation" ADD COLUMN     "contractAddress" TEXT;

-- CreateIndex
CREATE INDEX "Operation_contractAddress_idx" ON "Operation"("contractAddress");
