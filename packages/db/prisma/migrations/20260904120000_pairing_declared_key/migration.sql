-- The deploy account the CLI declares at `start`, so `/link` can show which
-- key is about to be attached. Nullable: it is unverified at approval time
-- (only a claim until `complete` presents a challenge signed by it), and rows
-- minted before this column existed have no value to backfill from.
ALTER TABLE "PairingState" ADD COLUMN "publicKey" TEXT;

-- Records a pairing the developer explicitly refused in the browser, so the
-- CLI can report "rejected" rather than sitting until the TTL expires.
ALTER TABLE "PairingState" ADD COLUMN "rejectedAt" TIMESTAMP(3);
