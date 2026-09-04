-- Polling fallback (#273): a credential the CLI holds and the pairing URL does
-- not, so a developer on a remote box can watch their own pairing without the
-- link itself granting that to anyone it gets pasted in front of. Hashed at
-- rest — it is a bearer token.
ALTER TABLE "PairingState" ADD COLUMN "pollTokenHash" TEXT;
CREATE UNIQUE INDEX "PairingState_pollTokenHash_key" ON "PairingState"("pollTokenHash");

-- The short code the browser shows after approval, pasted back into the
-- terminal when the loopback callback cannot be reached.
ALTER TABLE "PairingState" ADD COLUMN "handoffHash" TEXT;
