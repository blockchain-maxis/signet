import { seedContractFixture } from './fixtures/contracts';
import { seedDocsFailureFixture, startMockRpc } from './fixtures/docs-failures';

/**
 * Playwright `globalSetup`: loads the contract-page fixture (#463) into the
 * database, and only when there is one. The default `e2e` job is hermetic (no
 * `DATABASE_URL`), so this is a no-op there and nothing touches a database.
 *
 * With a database it also stands up the mock Soroban RPC the docs failure
 * states read (#470) and returns its teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!process.env.DATABASE_URL) return async () => {};
  await seedContractFixture();
  await seedDocsFailureFixture();
  return startMockRpc();
}
