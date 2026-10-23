//! The simulator's in-memory ledger: the layered copy-on-write store (#530)
//! and the `ledger_*` protocol verbs over it (schema/v1/ledger_*.json).

pub mod store;
pub mod verbs;
