-- Rewrite ContractInvocation primary key id to ${txHash}:${contractId}.
-- Previously corrupted rows (where scanning a second contract in the same transaction
-- overwrote the first contract's row with id ${txHash}:0) will correct themselves the
-- next time the transaction is in the scan window.
UPDATE "ContractInvocation" SET "id" = "txHash" || ':' || "contractId";
