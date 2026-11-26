-- CreateTable
CREATE TABLE "IndexerHeartbeat" (
    "worker" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "IndexerHeartbeat_pkey" PRIMARY KEY ("worker")
);
