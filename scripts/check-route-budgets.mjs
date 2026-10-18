import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * First-load JS budget for the contract page (I-04, #661).
 *
 * The contract page is the heaviest public page: a diagram, a function
 * reference, and client components for tabs and copy. This is the page
 * equivalent of the contract wasm's size budget in `.github/workflows/ci.yml`:
 * without one, the bundle grows unnoticed.
 *
 * Next 16's Turbopack build does not emit the classic
 * `.next/app-build-manifest.json`. It writes the per-route first-load chunk
 * lists to `.next/diagnostics/route-bundle-stats.json`, which is what this
 * reads. Each route's first-load JS is the gzip total of those chunks.
 *
 * Budgets start at the measured value plus 10%. Bump one deliberately when an
 * increase is expected and justified; see CONTRIBUTING.
 */

const WEB_ROOT = 'apps/web';
const STATS_PATH = join(WEB_ROOT, '.next', 'diagnostics', 'route-bundle-stats.json');

// route -> gzip budget in bytes, measured first-load JS + 10%.
const BUDGETS = new Map([
  ['/p/[handle]', 157225],
  ['/p/[handle]/contract/[address]', 167318],
  ['/p/[handle]/contract/[address]/activity', 167318],
  ['/p/[handle]/contract/[address]/diagram', 167318],
  ['/p/[handle]/contract/[address]/functions', 167318],
  ['/p/[handle]/contract/[address]/functions/[name]', 168282],
  ['/p/[handle]/contract/[address]/run', 169576],
  ['/p/[handle]/contract/[address]/types', 167318],
]);

function fail(message) {
  console.error(`[check-route-budgets] ${message}`);
  process.exit(1);
}

function gzipBytes(chunkPath) {
  const relative = chunkPath.split('\\').join('/');
  try {
    return gzipSync(readFileSync(join(WEB_ROOT, relative))).length;
  } catch {
    fail(`could not read a first-load chunk: ${relative}`);
  }
}

let stats;
try {
  stats = JSON.parse(readFileSync(STATS_PATH, 'utf8'));
} catch {
  fail(
    `could not read ${STATS_PATH}. Build the web app first: pnpm --filter @signet/web build`,
  );
}

const byRoute = new Map(stats.map((entry) => [entry.route, entry]));

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

let over = false;
const rows = [];

for (const [route, budget] of BUDGETS) {
  const entry = byRoute.get(route);
  if (!entry) {
    fail(`the build produced no stats for ${route}`);
  }
  const total = entry.firstLoadChunkPaths.reduce((sum, chunk) => sum + gzipBytes(chunk), 0);
  const ok = total <= budget;
  if (!ok) over = true;
  rows.push({ route, total, budget, ok });
}

const width = Math.max(...rows.map((row) => row.route.length));
for (const row of rows) {
  const status = row.ok ? 'ok' : 'OVER';
  console.log(
    `${row.route.padEnd(width)}  first-load ${kib(row.total).padStart(10)}  ` +
      `budget ${kib(row.budget).padStart(10)}  ${status}`,
  );
}

if (over) {
  fail('first-load JS exceeded its budget. Split the heavy client code, or bump the budget deliberately.');
}

console.log('✓ contract page first-load JS is within budget');
