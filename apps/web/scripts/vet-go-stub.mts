/**
 * Generates the Go client stub (#480) for the identity registry and the
 * `types_zoo` fixture, puts each in a throwaway Go module that depends on the
 * Stellar Go SDK, and runs `go vet` on it. Exits non-zero if either fails, so
 * CI catches a generator change that emits Go which does not compile.
 *
 *   node --experimental-strip-types scripts/vet-go-stub.mts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson } from '@signet/spec';
import { GO_SDK_MODULE, GO_SDK_VERSION, generateGoStub } from '../lib/docs/go-stub.ts';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/spec/fixtures',
);

const cases = [
  { name: 'registry', wasm: 'identity-registry.wasm' },
  { name: 'types_zoo', wasm: 'types_zoo.wasm' },
];

const go = (args: string[], cwd: string) =>
  execFileSync('go', args, { cwd, stdio: 'inherit', env: { ...process.env, GOFLAGS: '-mod=mod' } });

let failed = false;
for (const c of cases) {
  const spec = toSpecJson(parseContractSpec(fs.readFileSync(path.join(fixtures, c.wasm))));
  const source = generateGoStub(spec, {
    contractName: c.name,
    address: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
    network: 'testnet',
    wasmHash: spec.wasmHash,
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `signet-go-stub-${c.name}-`));
  try {
    fs.writeFileSync(path.join(dir, 'stub.go'), source);
    fs.writeFileSync(
      path.join(dir, 'go.mod'),
      `module example.com/stub\n\ngo 1.25\n\nrequire ${GO_SDK_MODULE} ${GO_SDK_VERSION}\n`,
    );
    go(['mod', 'tidy'], dir);
    go(['vet', './...'], dir);
    console.log(`go vet: ${c.name} stub ok`);
  } catch {
    console.error(`go vet: ${c.name} stub FAILED (left in ${dir})`);
    failed = true;
    continue;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
