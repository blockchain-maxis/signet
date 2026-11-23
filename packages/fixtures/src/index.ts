import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { replayHorizon, type HorizonReplay, type ReplayedResponse } from './replay.ts';

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

/**
 * One operation as Horizon returns it. The fields after `transaction_hash`
 * are those of an `invoke_host_function` record; other types carry their own
 * (a `create_account` has `funder`, `account` and `starting_balance`).
 */
export interface HorizonOperationRecord {
  id: string;
  paging_token: string;
  transaction_successful: boolean;
  source_account: string;
  type: string;
  type_i: number;
  created_at: string;
  transaction_hash: string;
  /**
   * The host function's type, as Horizon prints the Go XDR enum name: the type
   * name twice, e.g. `HostFunctionTypeHostFunctionTypeInvokeContract`.
   */
  function?: string;
  /** Base64 `ScVal`s. For an invocation: the contract, the function name, then the arguments. */
  parameters?: Array<{ value: string; type: string }> | null;
  /** For a create-contract from an address: the deployer. Empty otherwise. */
  address?: string;
  /** For a create-contract from an address: the 32-byte salt, as a decimal integer. Empty otherwise. */
  salt?: string;
  asset_balance_changes?: unknown[] | null;
  [field: string]: unknown;
}

/** A page of operations as Horizon returns it, before the SDK turns its links into functions. */
export interface HorizonOperationsPage {
  _links: {
    self: { href: string };
    next: { href: string };
    prev: { href: string };
  };
  _embedded: { records: HorizonOperationRecord[] };
}

export type FixtureName =
  | 'registry-instance-entry'
  | 'sac-instance-entry'
  | 'contract-wasm-entry'
  | 'claim-get-transaction'
  | 'deploy-get-transaction'
  | 'sac-transfer-call-get-transaction'
  | 'footprint-only-call-get-transaction'
  | 'horizon-contract-deploy-tx'
  | 'horizon-account-operations-page'
  | 'horizon-account-operations-first-page'
  | 'horizon-account-operations-end'
  | 'horizon-create-contract-v2-tx'
  | 'horizon-create-contract-operation';

export function loadFixtureEnvelope<T = unknown>(name: FixtureName): FixtureEnvelope<T> {
  const filePath = join(DATA_DIR, `${name}.json`);
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as FixtureEnvelope<T>;
}

export function loadFixture(
  name: 'registry-instance-entry' | 'sac-instance-entry' | 'contract-wasm-entry',
): GetLedgerEntriesResult;
export function loadFixture(
  name:
    | 'claim-get-transaction'
    | 'deploy-get-transaction'
    | 'sac-transfer-call-get-transaction'
    | 'footprint-only-call-get-transaction',
): GetTransactionResult;
export function loadFixture(
  name: 'horizon-contract-deploy-tx' | 'horizon-create-contract-v2-tx',
): HorizonTransactionResult;
export function loadFixture(
  name:
    | 'horizon-account-operations-page'
    | 'horizon-account-operations-first-page'
    | 'horizon-account-operations-end',
): HorizonOperationsPage;
export function loadFixture(name: 'horizon-create-contract-operation'): HorizonOperationRecord;
export function loadFixture<T = unknown>(name: FixtureName): T {
  const envelope = loadFixtureEnvelope<T>(name);
  return envelope.payload;
}
