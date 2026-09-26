-- Normalise stored Contract.network values:
-- 1. Rewrite public/pubnet (case-insensitive) to mainnet
UPDATE "Contract"
SET "network" = 'mainnet'
WHERE LOWER("network") IN ('public', 'pubnet');

-- 2. Lowercase all other network values
UPDATE "Contract"
SET "network" = LOWER("network")
WHERE "network" IS NOT NULL;

-- 3. Add CHECK constraint enforcing canonical network identifiers
ALTER TABLE "Contract"
DROP CONSTRAINT IF EXISTS "contract_network_check";

ALTER TABLE "Contract"
ADD CONSTRAINT "contract_network_check"
CHECK ("network" IN ('testnet', 'mainnet', 'futurenet', 'local'));
