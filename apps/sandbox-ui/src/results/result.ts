/**
 * @file A call result's meaning (#582, design note §6.2): a read, a write
 * preview, a contract error (an expected outcome the contract chose), or a
 * host error (the call could not run as asked). Pure, so the panel's choice
 * is tested on its own.
 */

import { Address, StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { SpecJson } from '@signet/spec';

export type ResultKind = 'read' | 'write' | 'contract-error' | 'host-error';

/** The fields of the CLI's call result (`cli-call-result.json`) the panel reads. */
export interface CallResultView {
  readonly network?: string;
  readonly forkId?: string;
  readonly forkLedger?: number;
  readonly forkTime?: string;
  readonly protocol?: number;
  readonly outcome?: 'result' | 'contract_error';
  readonly returnValue?: unknown;
  readonly returnValueXdr?: string;
  readonly error?: {
    readonly kind?: string;
    readonly code?: string;
    readonly message?: string;
    readonly decoded?: { error_enum?: string; error_name?: string; error_value?: number };
  };
  readonly events?: readonly { type?: string; event_xdr?: string; decoded?: { contract_id?: string; topics?: unknown[]; data?: unknown } }[];
  readonly authEntries?: readonly { credentials?: string; address?: string; root_function?: { contract_id?: string; function?: string } }[];
  readonly modifiedEntries?: readonly { key_xdr: string; before_xdr: string | null; after_xdr: string | null; live_until_ledger?: number }[];
  readonly resources?: { instructions?: number; disk_read_bytes?: number; write_bytes?: number };
  readonly fee?: { resource_fee?: number };
  readonly cost?: { cpu_insns?: number; mem_bytes?: number };
  readonly drift?: { forkLedger?: number; newestLedger?: number; keys?: readonly string[] };
  readonly authMode?: string;
  readonly storageOverrides?: readonly unknown[];
  readonly budget?: { instructions?: number };
  readonly unlimited?: boolean;
}

export function resultKind(r: CallResultView): ResultKind {
  if (r.outcome === 'contract_error') return r.error?.kind === 'contract' ? 'contract-error' : 'host-error';
  return (r.modifiedEntries?.length ?? 0) > 0 ? 'write' : 'read';
}

/** The accounts and contracts whose authorisation the write needs, in order, without duplicates. */
export function requiredSigners(r: CallResultView): string[] {
  return [...new Set((r.authEntries ?? []).flatMap((e) => (e.address ? [e.address] : [])))];
}

/** A contract error's spec entry: its doc, when the build documents it. */
export function errorDoc(r: CallResultView, spec: SpecJson | null): string | null {
  const d = r.error?.decoded;
  if (!d || !spec) return null;
  const entry = spec.errors.find((e) => e.name === d.error_name && (!d.error_enum || e.enumName === d.error_enum));
  return entry?.doc || null;
}

const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

function native(v: xdr.ScVal): string {
  try {
    return JSON.stringify(scValToNative(v), (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  } catch {
    return v.switch().name;
  }
}

/** A ledger key in words: `CASF…RCN persistent ["Owner","alice"]`, `account GAAZ…CWN7`. */
export function describeKey(keyXdr: string): string {
  try {
    const k = xdr.LedgerKey.fromXDR(keyXdr, 'base64');
    switch (k.switch().name) {
      case 'account':
        return `account ${short(StrKey.encodeEd25519PublicKey(k.account().accountId().ed25519()))}`;
      case 'contractData': {
        const d = k.contractData();
        const contract = short(Address.fromScAddress(d.contract()).toString());
        if (d.key().switch().name === 'scvLedgerKeyContractInstance') return `${contract} instance`;
        if (d.key().switch().name === 'scvLedgerKeyNonce') return `${contract} auth nonce`;
        return `${contract} ${d.durability().name} ${native(d.key())}`;
      }
      case 'contractCode':
        return 'contract code';
      case 'trustline':
        return `trustline of ${short(StrKey.encodeEd25519PublicKey(k.trustLine().accountId().ed25519()))}`;
      default:
        return k.switch().name;
    }
  } catch {
    return short(keyXdr);
  }
}

export interface StorageWrite {
  readonly key: string;
  readonly change: 'created' | 'updated' | 'deleted';
  readonly liveUntil?: number;
}

export function storageWrites(r: CallResultView): StorageWrite[] {
  return (r.modifiedEntries ?? []).map((e) => ({
    key: describeKey(e.key_xdr),
    change: e.before_xdr === null ? 'created' : e.after_xdr === null ? 'deleted' : 'updated',
    ...(e.live_until_ledger !== undefined && { liveUntil: e.live_until_ledger }),
  }));
}

/** How old the fork is: `14 min`, `3 h`, `2 d`. */
export function forkAge(forkTime: string | undefined, now: number): string | null {
  if (!forkTime) return null;
  const s = Math.max(0, Math.round((now - Date.parse(forkTime)) / 1000));
  if (Number.isNaN(s)) return null;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}
