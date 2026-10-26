/**
 * Loads the #463 contract-page fixture into DATABASE_URL, outside Playwright:
 * the same seeds `global-setup.ts` runs, without the mock RPC. For the load
 * test (scripts/load, #663), which runs against a plain `next start`.
 *
 * Usage, from apps/indexer (whose dependencies include tsx):
 *
 *   DATABASE_URL=… node --import tsx ../web/e2e/seed-fixture.mts
 */
import { seedContractFixture } from './fixtures/contracts';
import { seedDocsRegistryFixture } from './fixtures/docs-registry';
import { seedGroupedFixture } from './fixtures/grouped';
import { seedDocsFailureFixture } from './fixtures/docs-failures';

if (!process.env.DATABASE_URL) {
  console.error('seed-fixture: set DATABASE_URL to the database to load');
  process.exit(1);
}
await seedContractFixture();
await seedDocsFailureFixture();
await seedDocsRegistryFixture();
await seedGroupedFixture();
console.log('seed-fixture: loaded the contract-page fixture');
process.exit(0);
