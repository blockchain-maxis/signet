#!/usr/bin/env node
// Visualiser bundle guard (#544): cli/internal/visualise/bundle/visualiser.js
// is generated from packages/visualiser by
// packages/visualiser/scripts/build-cli-bundle.mts and committed, so the Go CLI
// embeds one layout instead of a second one in Go. Nothing keeps the committed
// file in step with the sources on its own: this rebuilds it in memory and
// fails when the body differs or the bundle is over its 2 MB budget. Needs the
// workspace installed (esbuild and the Stellar SDK are bundled in).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', 'packages/visualiser/scripts/build-cli-bundle.mts', '--check'],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
