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

use std::cell::RefCell;
use std::rc::Rc;

use crate::lanes::{ByteSnapshotSource, Lane, SourceFailed, SourceResult};
use crate::stdio::{Channel, FetchedBytes};

use super::store::LayeredStore;

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
        }
    }

    /// The keys fetched so far, in order.
    pub fn misses(&self) -> Vec<Vec<u8>> {
        self.misses.borrow().clone()
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
        if !self.store.borrow().knows(key_xdr) {
            self.fetch(key_xdr)?;
        }
        let found = self.store.borrow().get(key_xdr);
        found
    }
}
