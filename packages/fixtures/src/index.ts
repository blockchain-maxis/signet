import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');

export interface FixtureEnvelope<T = unknown> {
  network: string;
  rpcUrl: string;
  capturedAt: string;
  latestLedger: number;
  request: {
    endpoint: 'rpc' | 'horizon';
    methodOrPath: string;
    params?: unknown;
  };
  payload: T;
}

export interface GetLedgerEntriesResult {
  entries?: Array<{
    key: string;
    xdr: string;
    lastModifiedLedgerSeq: number;
    liveUntilLedgerSeq?: number;
    extXdr?: string;
  }>;
  latestLedger: number;
}

export interface GetTransactionResult {
  status: string;
  latestLedger: number;
  latestLedgerCloseTime: number;
  oldestLedger: number;
  oldestLedgerCloseTime: number;
  txHash: string;
  applicationOrder?: number;
  feeBump?: boolean;
  envelopeXdr?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  diagnosticEventsXdr?: string[];
  events?: Array<{
    type: string;
    ledger: number;
    ledgerClosedAt: string;
    contractId: string;
    id: string;
    pagingToken: string;
    inSuccessfulContractCall: boolean;
    topic: string[];
    value: string;
    txHash: string;
  }>;
  ledger?: number;
  createdAt?: number;
}

export interface HorizonTransactionResult {
  id: string;
  paging_token: string;
  successful: boolean;
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  source_account_sequence: string;
  fee_account: string;
  fee_charged: string | number;
  max_fee: string | number;
  operation_count: number;
  envelope_xdr: string;
  result_xdr: string;
  result_meta_xdr?: string;
  fee_meta_xdr?: string;
  memo_type: string;
  signatures: string[];
}

export type FixtureName =
  | 'registry-instance-entry'
  | 'sac-instance-entry'
  | 'contract-wasm-entry'
  | 'claim-get-transaction'
  | 'deploy-get-transaction'
  | 'horizon-contract-deploy-tx';

export function loadFixtureEnvelope<T = unknown>(name: FixtureName): FixtureEnvelope<T> {
  const filePath = join(DATA_DIR, `${name}.json`);
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as FixtureEnvelope<T>;
}

export function loadFixture(
  name: 'registry-instance-entry' | 'sac-instance-entry' | 'contract-wasm-entry',
): GetLedgerEntriesResult;
export function loadFixture(
  name: 'claim-get-transaction' | 'deploy-get-transaction',
): GetTransactionResult;
export function loadFixture(name: 'horizon-contract-deploy-tx'): HorizonTransactionResult;
export function loadFixture<T = unknown>(name: FixtureName): T {
  const envelope = loadFixtureEnvelope<T>(name);
  return envelope.payload;
}
