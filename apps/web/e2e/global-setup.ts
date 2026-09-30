import { seedContractFixture } from './fixtures/contracts';

/**
 * Playwright `globalSetup`: loads the contract-page fixture (#463) into the
 * database, and only when there is one. The default `e2e` job is hermetic (no
 * `DATABASE_URL`), so this is a no-op there and nothing touches a database.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await seedContractFixture();
}
