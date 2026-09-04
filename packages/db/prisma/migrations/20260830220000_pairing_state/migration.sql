-- CreateTable
CREATE TABLE "PairingState" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "network" TEXT NOT NULL,
    "profileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PairingState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PairingState_status_idx" ON "PairingState"("status");

-- AddForeignKey
ALTER TABLE "PairingState" ADD CONSTRAINT "PairingState_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
