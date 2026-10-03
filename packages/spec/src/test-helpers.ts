import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contract, type xdr } from '@stellar/stellar-sdk';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Decode a fixture's `contractspecv0` section without going through parseContractSpec. */
export function fixtureEntries(name: string): xdr.ScSpecEntry[] {
  const bytes = readFileSync(join(FIXTURES_DIR, `${name}.wasm`));
  const [section] = WebAssembly.Module.customSections(
    new WebAssembly.Module(bytes),
    'contractspecv0',
  );
  assert.ok(section, `${name} has a contractspecv0 section`);
  return new contract.Spec(Buffer.from(section)).entries;
}
