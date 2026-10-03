-- The user code (#596): a short code minted at `start`, printed by the CLI
-- and carried in the approval URL, which /link verifies against this hash
-- before rendering an Approve button. Hashed at rest — recovering the code
-- from the database would defeat the terminal/browser comparison. Existing
-- rows keep NULL and are refused by /link; they expire within 5 minutes.
ALTER TABLE "PairingState" ADD COLUMN "userCodeHash" TEXT;
