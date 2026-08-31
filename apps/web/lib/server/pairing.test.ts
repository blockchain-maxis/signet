import { test } from 'node:test';

/**
 * Adversarial coverage plan for the CLI pairing endpoints (issue #291).
 *
 * BLOCKED: `pair/start` and `pair/complete` don't exist on `main` yet. Both
 * are still on open, competing PRs —
 *   - #354 `feature/issue-266` (adds pair/start)
 *   - #364 `feat/cli-pair-complete-268` (adds pair/start, pair/approve,
 *     pair/complete, and `apps/web/lib/server/pairing.ts`)
 * — that overlap on `pair/start/route.ts`, so which implementation lands is
 * still unsettled. Writing real assertions here would mean guessing at an
 * API shape that may change under this file.
 *
 * The acceptance criteria from the issue are stubbed as `test.todo` below so
 * the coverage this issue asks for isn't lost, and the real bodies get filled
 * in once #354/#364 resolve. Each one is a fail-closed adversarial case
 * against `pair/complete`, in the same spirit as the SIWS replay coverage in
 * `../auth.test.ts` and the comment at `../auth.ts:99-120` — auth-adjacent
 * trust-boundary code that has already been bitten by exactly this class of
 * bug once.
 */

test.todo('rejects a replayed pairing code');
test.todo('rejects an expired pairing code');
test.todo('rejects a state mismatch');
test.todo('rejects completion with no session');
test.todo('rejects a valid session paired with an invalid CLI signature');
test.todo('rejects a signature over a different domain tag');
test.todo('rejects a network mismatch (mainnet CLI vs testnet session, or vice versa)');
test.todo('rejects a wallet already linked to another profile');
