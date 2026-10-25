//! `stellar snapshot create` files (#554), read with the
//! soroban-ledger-snapshot release that pins this lane's host. Only this lane
//! carries it, so a build without it cannot read snapshots.

use soroban_env_host_p28::xdr::{Limits, WriteXdr};
use soroban_ledger_snapshot_p28::LedgerSnapshot;

use crate::lanes::{SnapshotBytes, SnapshotEntryBytes};

/// A snapshot file's ledger and entries, as XDR bytes.
pub fn read_snapshot(text: &str) -> Result<SnapshotBytes, String> {
    let snapshot: LedgerSnapshot = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut entries = Vec::with_capacity(snapshot.ledger_entries.len());
    for (key, (entry, live_until)) in &snapshot.ledger_entries {
        let encode = |what: &str, r: Result<Vec<u8>, _>| {
            r.map_err(|e: soroban_env_host_p28::xdr::Error| format!("{what}: {e}"))
        };
        entries.push(SnapshotEntryBytes {
            key_xdr: encode("key", key.to_xdr(Limits::none()))?,
            data_xdr: encode("entry", entry.data.to_xdr(Limits::none()))?,
            ext_xdr: encode("entry ext", entry.ext.to_xdr(Limits::none()))?,
            last_modified_ledger_seq: entry.last_modified_ledger_seq,
            live_until: *live_until,
        });
    }
    Ok(SnapshotBytes {
        protocol_version: snapshot.protocol_version,
        sequence_number: snapshot.sequence_number,
        timestamp: snapshot.timestamp,
        network_id: snapshot.network_id,
        base_reserve: snapshot.base_reserve,
        min_persistent_entry_ttl: snapshot.min_persistent_entry_ttl,
        min_temp_entry_ttl: snapshot.min_temp_entry_ttl,
        max_entry_ttl: snapshot.max_entry_ttl,
        entries,
    })
}
