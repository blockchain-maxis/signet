-- CreateTable
CREATE TABLE "ContractInvocation" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "sourceAccount" TEXT NOT NULL,
    "function" TEXT,
    "successful" BOOLEAN NOT NULL,
    "wasmHash" TEXT,
    "readOnly" JSONB NOT NULL,
    "readWrite" JSONB NOT NULL,
    "changed" JSONB,
    "callEdges" JSONB,
    "eventsContractIds" TEXT[],
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContractInvocation_contractId_createdAt_idx" ON "ContractInvocation"("contractId", "createdAt");

-- CreateIndex
CREATE INDEX "ContractInvocation_contractId_function_idx" ON "ContractInvocation"("contractId", "function");

-- CreateIndex
CREATE INDEX "ContractInvocation_contractId_sourceAccount_idx" ON "ContractInvocation"("contractId", "sourceAccount");

-- AddForeignKey
ALTER TABLE "ContractInvocation" ADD CONSTRAINT "ContractInvocation_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
