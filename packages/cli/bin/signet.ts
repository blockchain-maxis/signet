#!/usr/bin/env -S node --experimental-strip-types
// `signet` CLI entrypoint. Runs directly from source with Node's native
// TypeScript type-stripping (Node ≥22, matching the rest of the workspace).
import { run } from '../src/cli.ts';

process.exit(await run(process.argv.slice(2)));