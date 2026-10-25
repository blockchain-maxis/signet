//! The copy-on-write ledger every run simulates against (#530).
//!
//! Every run must start from a known state: replays compare the deployed and
//! the new WASM from the *same* base, and a session chains calls so that call
//! 2 sees call 1's writes. The store is therefore layered:
//!
//! ```text
//!   session   — writes applied from `simulate` results, checkpointable
//!   overrides — `--set-storage` seeds (#559), via `ledger_put`
//!   base      — the fork: entries fetched from the live network
//! ```
//!
//! The topmost layer that knows a key answers for it; a deletion is a
//! [`Slot::Tombstone`], so a session delete hides a base entry without
//! touching it. Checkpoints freeze the session's current patch and cost
//! O(changed entries) — never a copy of the whole map — so ten thousand of
//! them hold exactly the entries that were written between them, which
//! [`LayeredStore::stored_entry_count`] makes assertable.
//!
//! An entry whose `live_until` has fallen below the current ledger sequence
//! reads as [`Lookup::Archived`], never as absent: what touching it means is
//! the host's call (from protocol 23 a call restores a persistent entry and
//! a temporary one is gone), which the fork's source hands it (#558).

//!
//! Keys and entries are kept as XDR bytes (#533): the store never decodes
//! them, so it serves every protocol lane alike, and each lane decodes with
//! its own XDR crate through [`ByteSnapshotSource`].

use std::collections::HashMap;
use std::rc::Rc;

use std::collections::HashSet;

use crate::lanes::{ByteSnapshotSource, SourceResult};

/// Which layer an entry came from — the provenance half every consumer of
/// `ledger_get` sees, so a surprising value can always be traced to the fork,
/// a `--set-storage` override, or a session write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Fork,
    Override,
    Session,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Fork => "fork",
            Source::Override => "override",
            Source::Session => "session",
        }
    }
}

/// Per-entry provenance carried alongside the entry itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Provenance {
    pub source: Source,
    /// The ledger the fork fetched this entry at; `None` off the fork layer.
    pub fetched_at_ledger: Option<u32>,
    /// The simulated ledger sequence that last wrote the entry here.
    pub last_modified_ledger_seq: u32,
}

/// One stored slot: a live entry with its expiry, or a deletion marker.
#[derive(Clone, Debug)]
enum Slot {
    Entry {
        entry: Rc<[u8]>,
        live_until: Option<u32>,
        provenance: Provenance,
    },
    Tombstone {
        // Kept so a deletion is traceable like any write (`ledger_get` does
        // not report deletions yet).
        #[allow(dead_code)]
        provenance: Provenance,
    },
}

/// What one key resolves to, archival applied.
#[derive(Clone, Debug)]
pub enum Lookup {
    Live {
        entry: Rc<[u8]>,
        live_until: Option<u32>,
        provenance: Provenance,
    },
    /// The entry exists but its `live_until` is below the current sequence.
    Archived {
        entry: Rc<[u8]>,
        live_until: u32,
        provenance: Provenance,
    },
    Absent,
}

/// Key type for the maps: the XDR bytes of the `LedgerKey`, so equality is
/// exactly the wire's and no `Ord`/`Hash` impl on any XDR type is needed.
type KeyBytes = Vec<u8>;

/// An entry written by [`LayeredStore::apply_modified`] or `ledger_put`.
pub struct Write {
    /// `LedgerKey` XDR.
    pub key: Vec<u8>,
    /// `LedgerEntry` XDR; `None` deletes the key (a tombstone in the receiving layer).
    pub entry: Option<Vec<u8>>,
    pub live_until: Option<u32>,
}

/// The layered, checkpointable ledger store.
pub struct LayeredStore {
    base: HashMap<KeyBytes, Slot>,
    /// Keys the fork asked the network for and learned do not exist: the
    /// negative cache that stops a session refetching them (#531).
    absent: HashSet<KeyBytes>,
    overrides: HashMap<KeyBytes, Slot>,
    /// Frozen session patches, oldest first. A checkpoint freezes `current`.
    frozen: Vec<HashMap<KeyBytes, Slot>>,
    /// The session writes since the last checkpoint.
    current: HashMap<KeyBytes, Slot>,
    /// Current simulated ledger sequence; drives archival.
    sequence: u32,
    /// Live slots stored across every layer — the size counter the
    /// no-quadratic-memory test asserts against.
    stored: usize,
}

impl LayeredStore {
    pub fn new(sequence: u32) -> Self {
        Self {
            base: HashMap::new(),
            absent: HashSet::new(),
            overrides: HashMap::new(),
            frozen: Vec::new(),
            current: HashMap::new(),
            sequence,
            stored: 0,
        }
    }

    pub fn sequence(&self) -> u32 {
        self.sequence
    }

    /// Advance (or rewind, for tests) the simulated sequence. Archival is
    /// evaluated lazily at read time against this value.
    pub fn set_sequence(&mut self, sequence: u32) {
        self.sequence = sequence;
    }

    /// Total slots held across base, overrides and every session patch.
    /// Grows with entries written, never with checkpoints taken.
    pub fn stored_entry_count(&self) -> usize {
        self.stored
    }

    #[allow(dead_code)] // consumed by #531/#534; unit-tested today.
    pub fn checkpoint_count(&self) -> usize {
        self.frozen.len()
    }

    /// Seed one fork entry, as a `ledger_fetch` answer does.
    pub fn insert_base(
        &mut self,
        key: &[u8],
        entry: Vec<u8>,
        live_until: Option<u32>,
        fetched_at_ledger: u32,
    ) {
        let slot = Slot::Entry {
            entry: entry.into(),
            live_until,
            provenance: Provenance {
                source: Source::Fork,
                fetched_at_ledger: Some(fetched_at_ledger),
                last_modified_ledger_seq: self.sequence,
            },
        };
        if self.base.insert(key.to_vec(), slot).is_none() {
            self.stored += 1;
        }
    }

    /// Record that the network has no entry at `key` (#531).
    pub fn insert_absent(&mut self, key: &[u8]) {
        self.absent.insert(key.to_vec());
    }

    /// Whether any layer has an answer for `key` (an entry, a deletion, or a
    /// known absence). A key nobody knows is one the fork has to fetch.
    pub fn knows(&self, key: &[u8]) -> bool {
        self.slot_for(key).is_some() || self.absent.contains(key)
    }

    /// Apply one `--set-storage` override (`ledger_put`).
    pub fn insert_override(&mut self, key: &[u8], entry: Vec<u8>, live_until: Option<u32>) {
        let slot = Slot::Entry {
            entry: entry.into(),
            live_until,
            provenance: Provenance {
                source: Source::Override,
                fetched_at_ledger: None,
                last_modified_ledger_seq: self.sequence,
            },
        };
        if self.overrides.insert(key.to_vec(), slot).is_none() {
            self.stored += 1;
        }
    }

    /// Remove a key in the override layer (`--unset-storage`, #559): a
    /// tombstone that hides the fork's entry without touching it.
    pub fn remove_override(&mut self, key: &[u8]) {
        let slot = Slot::Tombstone {
            provenance: Provenance {
                source: Source::Override,
                fetched_at_ledger: None,
                last_modified_ledger_seq: self.sequence,
            },
        };
        if self.overrides.insert(key.to_vec(), slot).is_none() {
            self.stored += 1;
        }
    }

    /// Apply a `simulate` result's `modified_entries` to the session layer:
    /// creations, updates, TTL extensions (same entry, higher `live_until`)
    /// and deletions (tombstones) all land here, so call 2 sees call 1's
    /// writes while the fork and the overrides stay untouched.
    pub fn apply_modified<I>(&mut self, writes: I)
    where
        I: IntoIterator<Item = Write>,
    {
        for write in writes {
            let provenance = Provenance {
                source: Source::Session,
                fetched_at_ledger: None,
                last_modified_ledger_seq: self.sequence,
            };
            let slot = match write.entry {
                Some(entry) => Slot::Entry {
                    entry: entry.into(),
                    live_until: write.live_until,
                    provenance,
                },
                None => Slot::Tombstone { provenance },
            };
            if self.current.insert(write.key, slot).is_none() {
                self.stored += 1;
            }
        }
    }

    /// Freeze the session's writes so far and return the checkpoint's id.
    /// Cost: O(1) moves — the patch holds only the entries changed since the
    /// previous checkpoint.
    pub fn checkpoint(&mut self) -> usize {
        let patch = std::mem::take(&mut self.current);
        self.frozen.push(patch);
        self.frozen.len()
    }

    /// Restore the state exactly as it was when `checkpoint` was taken:
    /// patches above it are discarded, writes since the last checkpoint too.
    /// The checkpoint itself stays valid, so a replay can roll back to the
    /// same point repeatedly.
    pub fn rollback(&mut self, checkpoint: usize) -> Result<(), ()> {
        if checkpoint > self.frozen.len() {
            return Err(());
        }
        for patch in self.frozen.drain(checkpoint..) {
            self.stored -= patch.len();
        }
        self.stored -= self.current.len();
        self.current = HashMap::new();
        Ok(())
    }

    fn slot_for(&self, bytes: &[u8]) -> Option<&Slot> {
        if let Some(slot) = self.current.get(bytes) {
            return Some(slot);
        }
        for patch in self.frozen.iter().rev() {
            if let Some(slot) = patch.get(bytes) {
                return Some(slot);
            }
        }
        self.overrides.get(bytes).or_else(|| self.base.get(bytes))
    }

    /// Resolve one key with overlay precedence and archival applied.
    pub fn lookup(&self, key: &[u8]) -> Lookup {
        match self.slot_for(key) {
            None | Some(Slot::Tombstone { .. }) => Lookup::Absent,
            Some(Slot::Entry {
                entry,
                live_until,
                provenance,
            }) => match live_until {
                Some(until) if *until < self.sequence => Lookup::Archived {
                    entry: entry.clone(),
                    live_until: *until,
                    provenance: *provenance,
                },
                _ => Lookup::Live {
                    entry: entry.clone(),
                    live_until: *live_until,
                    provenance: *provenance,
                },
            },
        }
    }
}

impl ByteSnapshotSource for LayeredStore {
    /// The live view: a live entry with its expiry, `None` for anything
    /// else, an archived entry included. Calls read through the fork's
    /// source instead, which gives the host archived entries as they are.
    fn get(&self, key_xdr: &[u8]) -> SourceResult {
        Ok(match self.lookup(key_xdr) {
            Lookup::Live {
                entry, live_until, ..
            } => Some((entry, live_until)),
            Lookup::Archived { .. } | Lookup::Absent => None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The store never decodes what it holds, so opaque bytes exercise it
    // exactly as real XDR would: a key per `n`, an entry carrying `v`.
    fn key(n: u32) -> Vec<u8> {
        [b"key:".as_slice(), &n.to_be_bytes()].concat()
    }

    fn entry(n: u32, v: u32) -> Vec<u8> {
        [b"entry:".as_slice(), &n.to_be_bytes(), &v.to_be_bytes()].concat()
    }

    fn live_value(store: &LayeredStore, n: u32) -> Option<u32> {
        match store.lookup(&key(n)) {
            Lookup::Live { entry, .. } => {
                Some(u32::from_be_bytes(entry[10..14].try_into().unwrap()))
            }
            _ => None,
        }
    }

    fn write(n: u32, v: u32) -> Write {
        Write {
            key: key(n),
            entry: Some(entry(n, v)),
            live_until: Some(1_000),
        }
    }

    fn delete(n: u32) -> Write {
        Write {
            key: key(n),
            entry: None,
            live_until: None,
        }
    }

    fn snapshot_bytes(store: &LayeredStore, upto: u32) -> Vec<Option<Vec<u8>>> {
        (0..upto)
            .map(|n| match store.lookup(&key(n)) {
                Lookup::Live { entry, .. } => Some(entry.to_vec()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn overlay_precedence_is_session_then_override_then_base() {
        let mut store = LayeredStore::new(100);
        store.insert_base(&key(1), entry(1, 10), Some(1_000), 42);
        assert_eq!(live_value(&store, 1), Some(10));

        store.insert_override(&key(1), entry(1, 20), Some(1_000));
        assert_eq!(live_value(&store, 1), Some(20));

        store.apply_modified([write(1, 30)]);
        assert_eq!(live_value(&store, 1), Some(30));

        // Provenance follows the winning layer.
        let Lookup::Live { provenance, .. } = store.lookup(&key(1)) else {
            panic!("expected live");
        };
        assert_eq!(provenance.source, Source::Session);
    }

    #[test]
    fn a_tombstone_hides_a_lower_layer_without_touching_it() {
        let mut store = LayeredStore::new(100);
        store.insert_base(&key(1), entry(1, 10), Some(1_000), 42);
        store.apply_modified([delete(1)]);
        assert!(matches!(store.lookup(&key(1)), Lookup::Absent));

        // Rolling the session away brings the base entry back untouched.
        let cp = {
            let mut fresh = LayeredStore::new(100);
            fresh.insert_base(&key(1), entry(1, 10), Some(1_000), 42);
            let cp = fresh.checkpoint();
            fresh.apply_modified([delete(1)]);
            assert!(matches!(fresh.lookup(&key(1)), Lookup::Absent));
            fresh.rollback(cp).unwrap();
            assert_eq!(live_value(&fresh, 1), Some(10));
            cp
        };
        assert_eq!(cp, 1);
    }

    #[test]
    fn rollback_restores_byte_identical_state_and_keeps_the_checkpoint_valid() {
        let mut store = LayeredStore::new(100);
        for n in 0..8 {
            store.insert_base(&key(n), entry(n, n), Some(1_000), 42);
        }
        store.apply_modified([write(2, 222)]);
        let before = snapshot_bytes(&store, 10);

        let cp = store.checkpoint();
        store.apply_modified([write(0, 99), write(8, 88), delete(3)]);
        assert_ne!(snapshot_bytes(&store, 10), before);

        store.rollback(cp).unwrap();
        assert_eq!(snapshot_bytes(&store, 10), before);

        // The checkpoint stays valid: mutate and roll back to it again.
        store.apply_modified([delete(0), write(9, 9)]);
        store.rollback(cp).unwrap();
        assert_eq!(snapshot_bytes(&store, 10), before);
    }

    #[test]
    fn ten_thousand_checkpoints_store_only_their_changes() {
        let mut store = LayeredStore::new(100);
        store.insert_base(&key(0), entry(0, 0), Some(1_000_000), 42);

        for n in 0..10_000u32 {
            store.apply_modified([write(n % 16, n)]);
            store.checkpoint();
        }
        assert_eq!(store.checkpoint_count(), 10_000);
        // One base entry plus exactly one stored slot per checkpointed write:
        // memory is linear in writes, not quadratic in checkpoints.
        assert_eq!(store.stored_entry_count(), 1 + 10_000);
        // And the layered view still resolves to the latest write.
        assert_eq!(live_value(&store, 15), Some(9_999));
    }

    #[test]
    fn an_entry_past_its_live_until_reads_as_archived() {
        let mut store = LayeredStore::new(100);
        store.insert_base(&key(1), entry(1, 10), Some(100), 42);
        assert!(matches!(store.lookup(&key(1)), Lookup::Live { .. }));

        store.set_sequence(101);
        let Lookup::Archived {
            live_until,
            provenance,
            ..
        } = store.lookup(&key(1))
        else {
            panic!("expected archived");
        };
        assert_eq!(live_until, 100);
        assert_eq!(provenance.source, Source::Fork);

        // The live view leaves it out.
        assert!(ByteSnapshotSource::get(&store, &key(1)).unwrap().is_none());

        // A TTL extension applied from a simulate result revives it.
        store.apply_modified([Write {
            key: key(1),
            entry: Some(entry(1, 10)),
            live_until: Some(200),
        }]);
        assert!(matches!(store.lookup(&key(1)), Lookup::Live { .. }));
    }

    #[test]
    fn provenance_names_the_layer_and_its_ledgers() {
        let mut store = LayeredStore::new(100);
        store.insert_base(&key(1), entry(1, 1), Some(1_000), 42);
        store.insert_override(&key(2), entry(2, 2), Some(1_000));
        store.set_sequence(105);
        store.apply_modified([write(3, 3)]);

        let Lookup::Live {
            provenance: fork, ..
        } = store.lookup(&key(1))
        else {
            panic!()
        };
        assert_eq!(fork.source, Source::Fork);
        assert_eq!(fork.fetched_at_ledger, Some(42));

        let Lookup::Live {
            provenance: over, ..
        } = store.lookup(&key(2))
        else {
            panic!()
        };
        assert_eq!(over.source, Source::Override);
        assert_eq!(over.fetched_at_ledger, None);

        let Lookup::Live {
            provenance: session,
            ..
        } = store.lookup(&key(3))
        else {
            panic!()
        };
        assert_eq!(session.source, Source::Session);
        assert_eq!(session.last_modified_ledger_seq, 105);
    }
}
