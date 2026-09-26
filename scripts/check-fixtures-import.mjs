import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PRODUCTION_DIRS = [
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'apps/indexer/src',
  'packages/sdk/src',
  'packages/types/src',
  'packages/db/src',
];

const FORBIDDEN_IMPORT_PATTERNS = [/@signet\/fixtures/, /packages\/fixtures/, /\.\.\/.*fixtures/];

let failed = false;

function scanDir(dirPath) {
  let entries = [];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next' && entry !== 'dist') {
        scanDir(fullPath);
      }
    } else if (
      (fullPath.endsWith('.ts') ||
        fullPath.endsWith('.tsx') ||
        fullPath.endsWith('.js') ||
        fullPath.endsWith('.mjs')) &&
      !fullPath.includes('.test.') &&
      !fullPath.includes('.spec.') &&
      !fullPath.includes('/e2e/')
    ) {
      const content = readFileSync(fullPath, 'utf8');
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(content)) {
          console.error(
            `[check-fixtures-import] Production file ${fullPath} imports from fixtures: ${pattern}`,
          );
          failed = true;
        }
      }
    }
  }
}

for (const dir of PRODUCTION_DIRS) {
  scanDir(dir);
}

if (failed) {
  console.error(
    '[check-fixtures-import] FAILED: @signet/fixtures must not be imported in production code.',
  );
  process.exit(1);
} else {
  console.log('✓ No production code imports @signet/fixtures');
}
