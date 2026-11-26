//! The fork's lazy layer (#531): a [`ByteSnapshotSource`] over the session
//! store that asks Go for any key the store has never heard of.
//!
//! RPC cannot list a contract's keys, and a call's footprint is only known
//! once it runs, so entries arrive on demand. On a miss the source sends
//! `ledger_fetch` over the stdio channel and blocks until Go answers; the
//! answer goes into the fork layer, an absent key into the negative cache, so
//! a session never asks for the same key twice. Every key fetched during one
//! request is recorded as a miss, and `simulate` returns them so Go can
//! prefetch them next time (#552).
//!
//! In `deny` mode (offline runs and bundle replay, #573) a miss is an error
//! naming the key instead.
//!
//! Every contract whose instance a request reads is recorded, so a call can
//! report the contracts it reached (#552); restricted to one contract, the
//! source refuses to read any other's instance, naming it.

use std::cell::RefCell;
use std::rc::Rc;

use crate::lanes::{ByteSnapshotSource, Lane, SourceFailed, SourceResult};
use crate::stdio::{Channel, FetchedBytes};

use super::store::{LayeredStore, Lookup};

/// Whether a miss may go to Go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchMode {
    Allow,
    Deny,
}

/// Why the source gave up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchFailure {
    /// `fetch_failed`'s `detail.kind`: `denied`, or what Go reported
    /// (`rpc_unavailable`, `timeout`, `rejected`).
    pub kind: String,
    pub message: String,
    /// The key that could not be served, as XDR.
    pub key: Vec<u8>,
}

pub struct FetchingSource {
    store: Rc<RefCell<LayeredStore>>,
    channel: Rc<RefCell<Channel>>,
    lane: &'static dyn Lane,
    mode: FetchMode,
    misses: RefCell<Vec<Vec<u8>>>,
    failure: RefCell<Option<FetchFailure>>,
    /// Entries read while archived, with their `live_until` (#558).
    archived: RefCell<Vec<(Vec<u8>, u32)>>,
    /// Contracts whose instance was read, in order, without repeats (#552).
    instances: RefCell<Vec<String>>,
    /// When set, the only contract whose instance may be read.
    only: RefCell<Option<String>>,
}

impl FetchingSource {
    pub fn new(
        store: Rc<RefCell<LayeredStore>>,
        channel: Rc<RefCell<Channel>>,
        lane: &'static dyn Lane,
        mode: FetchMode,
    ) -> Self {
        Self {
            store,
            channel,
            lane,
            mode,
            misses: RefCell::new(Vec::new()),
            failure: RefCell::new(None),
            archived: RefCell::new(Vec::new()),
            instances: RefCell::new(Vec::new()),
            only: RefCell::new(None),
        }
    }

    /// Keep this request to `contract`: reading another contract's instance
    /// fails with `related`, naming it (#552's `--no-related`).
    pub fn restrict_to(&self, contract: &str) {
        *self.only.borrow_mut() = Some(contract.to_string());
    }

    /// The contracts whose instance was read so far, in order.
    pub fn instances(&self) -> Vec<String> {
        self.instances.borrow().clone()
    }

    /// The keys fetched so far, in order.
    pub fn misses(&self) -> Vec<Vec<u8>> {
        self.misses.borrow().clone()
    }

    /// The archived entries read so far, with their `live_until`, in order
    /// and without repeats.
    pub fn archived(&self) -> Vec<(Vec<u8>, u32)> {
        self.archived.borrow().clone()
    }

    /// Why the source gave up, if it did.
    pub fn failure(&self) -> Option<FetchFailure> {
        self.failure.borrow().clone()
    }

    fn fail(&self, kind: &str, message: String, key: &[u8]) -> SourceFailed {
        *self.failure.borrow_mut() = Some(FetchFailure {
            kind: kind.to_string(),
            message,
            key: key.to_vec(),
        });
        SourceFailed
    }

    /// Ask Go for `key` and file the answer in the store.
    fn fetch(&self, key: &[u8]) -> Result<(), SourceFailed> {
        if self.mode == FetchMode::Deny {
            return Err(self.fail(
                "denied",
                format!(
                    "{} is not in this ledger and fetching is off",
                    self.lane.describe_key(key)
                ),
                key,
            ));
        }
        let answer = self.channel.borrow_mut().fetch(&[key.to_vec()]);
        let entries = answer.map_err(|e| self.fail(e.kind(), e.message(), key))?;
        let mut store = self.store.borrow_mut();
        let fetched_at = store.sequence();
        for fetched in entries {
            let entry = match fetched.entry {
                None => {
                    store.insert_absent(&fetched.key);
                    continue;
                }
                Some(FetchedBytes::Entry(entry)) => entry,
                Some(FetchedBytes::Data {
                    data,
                    last_modified_ledger_seq,
                    ext,
                }) => self
                    .lane
                    .assemble_entry(&data, last_modified_ledger_seq, ext.as_deref())
                    .map_err(|e| {
                        self.fail(
                            "rejected",
                            format!(
                                "Go's entry for {} is unusable: {e}",
                                self.lane.describe_key(key)
                            ),
                            key,
                        )
                    })?,
            };
            if let Err(e) = self.lane.check_ledger_entry(&entry) {
                return Err(self.fail(
                    "rejected",
                    format!(
                        "Go's entry for {} is unusable: {e}",
                        self.lane.describe_key(key)
                    ),
                    key,
                ));
            }
            let derived = self.lane.entry_key(&entry).map_err(|e| {
                self.fail(
                    "rejected",
                    format!(
                        "Go's entry for {} is unusable: {e}",
                        self.lane.describe_key(key)
                    ),
                    key,
                )
            })?;
            if derived != fetched.key {
                return Err(self.fail(
                    "rejected",
                    format!(
                        "Go's entry for {} belongs to {}",
                        self.lane.describe_key(&fetched.key),
                        self.lane.describe_key(&derived),
                    ),
                    key,
                ));
            }
            store.insert_base(&fetched.key, entry, fetched.live_until, fetched_at);
        }
        self.misses.borrow_mut().push(key.to_vec());
        Ok(())
    }
}

impl ByteSnapshotSource for FetchingSource {
    fn get(&self, key_xdr: &[u8]) -> SourceResult {
        if self.failure.borrow().is_some() {
            return Err(SourceFailed);
        }
        if let Some(owner) = self.lane.instance_owner(key_xdr) {
            let only = self.only.borrow().clone();
            if let Some(only) = only.filter(|only| *only != owner) {
                return Err(self.fail(
                    "related",
                    format!("the call reached another contract, {owner}, and this run is kept to {only}"),
                    key_xdr,
                ));
            }
            let mut instances = self.instances.borrow_mut();
            if !instances.contains(&owner) {
                instances.push(owner);
            }
        }
        if !self.store.borrow().knows(key_xdr) {
            self.fetch(key_xdr)?;
        }
        let lookup = self.store.borrow().lookup(key_xdr);
        match lookup {
            // The host gets an archived entry as it is, stale TTL and all:
            // from protocol 23 it restores a persistent one in the same
            // transaction and treats a temporary one as gone (CAP-66),
            // exactly as the network would. The caller hears which.
            Lookup::Archived {
                entry, live_until, ..
            } => {
                let mut archived = self.archived.borrow_mut();
                if !archived.iter().any(|(k, _)| k == key_xdr) {
                    archived.push((key_xdr.to_vec(), live_until));
                }
                Ok(Some((entry, Some(live_until))))
            }
            Lookup::Live {
                entry, live_until, ..
            } => Ok(Some((entry, live_until))),
            // A key the session deleted or an override unset is known to
            // the store, so it was not fetched above: the entry stays hidden
            // and the network is not asked for it again (#934).
            Lookup::Deleted { .. } | Lookup::Absent => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use serde_json::json;

    use super::*;
    #[cfg(feature = "lane-p28")]
    use crate::lanes::p28::fixtures;
    #[cfg(all(not(feature = "lane-p28"), feature = "lane-p29"))]
    use crate::lanes::p29::fixtures;
    use crate::lanes::LaneRegistry;

    #[test]
    fn go_returning_entry_for_wrong_key_is_rejected() {
        let key_a = fixtures::data_key_xdr(1);
        let entry_b = fixtures::data_entry_xdr(2, 20);
        let reply = json!({
            "version": 1,
            "id": "sim-1",
            "type": "ledger_entries",
            "entries": [{
                "key_xdr": BASE64.encode(&key_a),
                "entry_xdr": BASE64.encode(&entry_b),
            }],
        });
        let line = format!("{reply}\n");
        let channel = Rc::new(RefCell::new(Channel::new(
            Box::new(Cursor::new(line.into_bytes())),
            Box::new(std::io::sink()),
            1 << 20,
        )));
        let store = Rc::new(RefCell::new(LayeredStore::new(1)));
        let lane = LaneRegistry::builtin().newest();
        let src = FetchingSource::new(store, channel, lane, FetchMode::Allow);
        assert!(src.get(&key_a).is_err());
        let failure = src.failure().expect("expected fetch failure");
        assert_eq!(failure.kind, "rejected");
        assert!(
            failure.message.contains("belongs to"),
            "unexpected failure message: {}",
            failure.message
        );
    }

    #[test]
    fn a_key_the_session_deleted_reads_as_no_entry_and_is_not_fetched() {
        // In `deny` mode a miss is an error, so an answer of "no entry" with
        // no failure recorded means the network was not asked (#934).
        let (deleted, unset) = (fixtures::data_key_xdr(1), fixtures::data_key_xdr(2));
        let store = Rc::new(RefCell::new(LayeredStore::new(1)));
        {
            let mut store = store.borrow_mut();
            store.insert_base(&deleted, fixtures::data_entry_xdr(1, 10), Some(500), 1);
            store.insert_base(&unset, fixtures::data_entry_xdr(2, 20), Some(500), 1);
            store.apply_modified([crate::ledger::store::Write {
                key: deleted.clone(),
                entry: None,
                live_until: None,
            }]);
            store.remove_override(&unset);
        }
        let channel = Rc::new(RefCell::new(Channel::new(
            Box::new(Cursor::new(Vec::new())),
            Box::new(std::io::sink()),
            1 << 20,
        )));
        let lane = LaneRegistry::builtin().newest();
        let src = FetchingSource::new(store, channel, lane, FetchMode::Deny);

        assert!(src.get(&deleted).unwrap().is_none());
        assert!(src.get(&unset).unwrap().is_none());
        assert!(src.failure().is_none(), "{:?}", src.failure());

        // The same source does refuse a key nobody knows.
        assert!(src.get(&fixtures::data_key_xdr(3)).is_err());
        assert_eq!(src.failure().expect("a denied fetch").kind, "denied");
    }
}
