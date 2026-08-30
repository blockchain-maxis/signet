-- CreateTable
CREATE TABLE "CliPairing" (
    "id" TEXT NOT NULL,
    "pairingCode" TEXT NOT NULL,
    "pollToken" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "completionCode" TEXT,
    "publicKey" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "proven" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "profileId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CliPairing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CliPairing_pairingCode_key" ON "CliPairing"("pairingCode");

-- CreateIndex
CREATE UNIQUE INDEX "CliPairing_pollToken_key" ON "CliPairing"("pollToken");

-- CreateIndex
CREATE UNIQUE INDEX "CliPairing_completionCode_key" ON "CliPairing"("completionCode");
