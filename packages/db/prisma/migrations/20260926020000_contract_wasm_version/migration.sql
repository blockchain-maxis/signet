-- AlterTable
ALTER TABLE "Contract" ADD COLUMN "wasmHash" TEXT;
ALTER TABLE "Contract" ADD COLUMN "executableType" TEXT;
ALTER TABLE "Contract" ADD COLUMN "wasmHashCheckedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ContractWasmVersion" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "wasmHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observedLedger" INTEGER NOT NULL,

    CONSTRAINT "ContractWasmVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contract_wasmHash_idx" ON "Contract"("wasmHash");

-- CreateIndex
CREATE UNIQUE INDEX "ContractWasmVersion_contractId_wasmHash_key" ON "ContractWasmVersion"("contractId", "wasmHash");

-- CreateIndex
CREATE INDEX "ContractWasmVersion_contractId_observedAt_idx" ON "ContractWasmVersion"("contractId", "observedAt");

-- AddForeignKey
ALTER TABLE "ContractWasmVersion" ADD CONSTRAINT "ContractWasmVersion_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
