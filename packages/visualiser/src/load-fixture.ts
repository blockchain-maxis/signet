/**
 * @file Test helper: rebuild a `ContractSpec` from a committed real-contract
 * fixture (#483), with no network.
 *
 * A fixture (`fixtures/<name>.spec.json`, written by
 * `scripts/capture-fixture.mts`) holds only the provenance and the spec
 * entries' XDR. `fromSpecJson` (#434) wants a full `SpecJson` with the
 * flattened views, so this helper builds the views from the decoded entries
 * with the reader's own `buildSpecViews` / `buildEvents`, assembles the
 * `SpecJson`, and lets `fromSpecJson` do the XDR decoding. The WASM is not
 * stored, so `build` and `env` (contract meta) are absent from these specs.
 *
 * Test code only: nothing outside `*.test.ts` files imports this.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdr } from '@stellar/stellar-sdk';
import {
  SPEC_JSON_SCHEMA_VERSION,
  STELLAR_SDK_VERSION,
  buildEvents,
  buildSpecViews,
  fromSpecJson,
} from '@signet/spec';
import type { ContractSpec } from '@signet/spec';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** The on-disk shape of `fixtures/<name>.spec.json`. */
export interface SpecFixture {
  network: string;
  address: string;
  wasmHash: string;
  capturedAtLedger: number;
  entriesXdrBase64: string[];
}

/** Read a fixture file as-is, with its provenance fields. */
export function readFixture(name: string): SpecFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.spec.json`), 'utf8')) as SpecFixture;
}

/** Rebuild the `ContractSpec` of a captured contract, offline. */
export function loadFixture(name: string): ContractSpec {
  const fixture = readFixture(name);
  const entries = fixture.entriesXdrBase64.map((b64) => xdr.ScSpecEntry.fromXDR(b64, 'base64'));
  return fromSpecJson({
    schemaVersion: SPEC_JSON_SCHEMA_VERSION,
    wasmHash: fixture.wasmHash,
    sdkVersion: STELLAR_SDK_VERSION,
    entriesXdr: fixture.entriesXdrBase64,
    ...buildSpecViews(entries),
    events: buildEvents(entries),
    warnings: [],
  });
}
