-- Activity counts now come from ContractInvocation (#429). `countedSince` is the
-- oldest invocation the counts cover; `totalIsFloor` marks a total that hit the
-- per-contract capture cap. Existing rows keep NULL / false: they were written
-- by the Horizon path, are all zeros, and NULL countedSince is how readers
-- tell them apart.
ALTER TABLE "ContractSnapshot" ADD COLUMN "countedSince" TIMESTAMP(3),
ADD COLUMN "totalIsFloor" BOOLEAN NOT NULL DEFAULT false;
