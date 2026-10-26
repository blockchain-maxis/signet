#!/usr/bin/env node
// Writes calls-getLedgerEntries.json: what an RPC would answer for a pair of
// contracts where one calls the other (#552), built from the sandbox's
// `caller` and `callee` fixture WASMs (sandbox/fixtures), and a deployed
// `counter_v1` for signet dev --ci's tests (#639). Not a recording:
// the contracts are not deployed anywhere. Their ids are sha256 of a fixed
// label, and their entries are dated before the registry's fork ledger
// (4887004) with the registry's TTL, so a fork of them sees no drift.
//
//   node cli/internal/rpc/testdata/registry/generate-calls.mjs
//
// Needs the workspace installed (the Stellar SDK is resolved from packages/spec).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const { xdr, StrKey } = createRequire(join(root, 'packages', 'spec', 'package.json'))(
  '@stellar/stellar-sdk',
);

const LAST_MODIFIED = 4880000;
const LIVE_UNTIL = 4916420;
const sha = (b) => createHash('sha256').update(b).digest();

const entries = [];
const ids = {};
for (const name of ['caller', 'callee', 'counter_v1']) {
  const wasm = readFileSync(join(root, 'sandbox', 'fixtures', 'wasm', `${name}.wasm`));
  const hash = sha(wasm);
  const id = sha(`signet-test-${name}`);
  ids[name] = StrKey.encodeContract(id);
  const address = xdr.ScAddress.scAddressTypeContract(id);
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: address,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const instance = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: address,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(hash),
          storage: null,
        }),
      ),
    }),
  );
  const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }));
  const code = xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({ ext: new xdr.ContractCodeEntryExt(0), hash, code: wasm }),
  );
  for (const [key, data] of [
    [instanceKey, instance],
    [codeKey, code],
  ]) {
    entries.push({
      key: key.toXDR('base64'),
      xdr: data.toXDR('base64'),
      lastModifiedLedgerSeq: LAST_MODIFIED,
      liveUntilLedgerSeq: LIVE_UNTIL,
      extXdr: 'AAAAAA==',
    });
  }
}

writeFileSync(
  join(here, 'calls-getLedgerEntries.json'),
  `${JSON.stringify({ contracts: ids, entries }, null, 2)}\n`,
);
console.log(
  Object.entries(ids)
    .map(([name, id]) => `${name} ${id}`)
    .join('\n'),
);
