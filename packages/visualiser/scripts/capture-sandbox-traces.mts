/**
 * @file Capture sandbox call traces of the testnet identity registry as
 * committed test fixtures (#542).
 *
 *   node --experimental-strip-types scripts/capture-sandbox-traces.mts [simulator]
 *
 * Run by hand only. It drives a built `signet-simulator` (default: the
 * sandbox's debug build) over its NDJSON protocol: it opens a fork of the
 * registry at the recorded ledger, answers every `ledger_fetch` from the
 * simulator's recorded `getLedgerEntries` fixtures (so nothing touches the
 * network), and simulates `count` and `claim` with `trace: true` and
 * `dry_run`, writing each `trace` to `fixtures/sandbox/registry-<fn>.trace.json`.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const recorded = join(root, 'sandbox', 'simulator', 'tests', 'fixtures');
const out = join(here, '..', 'fixtures', 'sandbox');
const simulator = process.argv[2] ?? join(root, 'sandbox', 'target', 'debug', 'signet-simulator');

const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const FORK_LEDGER = 4887004;
const WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

interface RecordedEntry {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
  extXdr?: string;
  liveUntilLedgerSeq?: number;
}

const entries = new Map<string, object>();
for (const name of [
  'network-config-entries.json',
  'registry-instance-entry.json',
  'registry-code-entry.json',
]) {
  const fixture = JSON.parse(readFileSync(join(recorded, name), 'utf8')) as {
    payload: { entries: RecordedEntry[] };
  };
  for (const e of fixture.payload.entries) {
    entries.set(e.key, {
      key_xdr: e.key,
      data_xdr: e.xdr,
      last_modified_ledger_seq: e.lastModifiedLedgerSeq,
      ext_xdr: e.extXdr ?? null,
      live_until_ledger: e.liveUntilLedgerSeq ?? null,
    });
  }
}

const child = spawn(simulator, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const write = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
let next = 0;

async function send(message: object): Promise<Record<string, unknown>> {
  const id = `req-${++next}`;
  write({ version: 1, id, ...message });
  for (;;) {
    const { value, done } = await lines.next();
    if (done) throw new Error('the simulator exited');
    const reply = JSON.parse(value) as Record<string, unknown>;
    if (reply.type === 'ledger_fetch') {
      const keys = reply.keys_xdr as string[];
      write({
        version: 1,
        id: reply.id,
        type: 'ledger_entries',
        entries: keys.flatMap((k) => (entries.has(k) ? [entries.get(k)] : [])),
      });
      continue;
    }
    if (reply.id !== id) throw new Error(`unexpected reply ${value}`);
    return reply;
  }
}

await send({ type: 'hello', client_protocol_version: 1 });
const open = await send({
  type: 'ledger_open',
  network_passphrase: 'Test SDF Network ; September 2015',
  ledger_protocol: 29,
  sequence: FORK_LEDGER,
});
if (open.type !== 'result') throw new Error(`ledger_open: ${JSON.stringify(open)}`);

for (const [fn, args] of [
  ['count', {}],
  ['claim', { handle: 'trace-fixture', wallet: WALLET }],
] as const) {
  const reply = await send({
    type: 'simulate',
    contract_id: REGISTRY,
    function: fn,
    args,
    trace: true,
    dry_run: true,
  });
  if (reply.type !== 'result') throw new Error(`${fn}: ${JSON.stringify(reply)}`);
  const file = join(out, `registry-${fn}.trace.json`);
  writeFileSync(file, JSON.stringify(reply.trace, null, 2) + '\n');
  console.log(`wrote ${file}`);
}
await send({ type: 'shutdown' });
child.stdin.end();
