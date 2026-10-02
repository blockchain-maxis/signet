-- CreateTable
CREATE TABLE "ContractSpec" (
    "wasmHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "sdkVersion" TEXT NOT NULL,
    "specJson" JSONB NOT NULL,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractSpec_pkey" PRIMARY KEY ("wasmHash")
);
