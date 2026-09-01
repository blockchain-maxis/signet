-- DropIndex
-- Profile.handle and Wallet.pubkey are already backed by the unique
-- constraints created in 20260609000000_init (Profile_handle_key,
-- Wallet_pubkey_key). Postgres builds a b-tree index to enforce a unique
-- constraint, so the separate @@index([handle]) / @@index([pubkey]) declared
-- on the same columns were pure duplicates: identical lookup performance,
-- plus the extra write and storage cost of maintaining a second index on
-- every insert/update.
DROP INDEX "Profile_handle_idx";

-- DropIndex
DROP INDEX "Wallet_pubkey_idx";
