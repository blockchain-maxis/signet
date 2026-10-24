//! The stdio channel: one line reader and one writer, shared by the message
//! loop and by [`Channel::fetch`], the one request the simulator sends Go
//! (`ledger_fetch`, #531).
//!
//! The channel lives behind `Rc<RefCell<…>>` because a fetch happens deep
//! inside a host call: the snapshot source the host reads through holds the
//! channel, sends `ledger_fetch` and blocks on Go's `ledger_entries` before
//! the host continues. Everything is single-threaded, as the protocol is.

use std::collections::VecDeque;
use std::io::{self, BufRead, Write};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

use crate::framing::{Line, LineReader};
use crate::PROTOCOL_VERSION;

/// One entry in Go's `ledger_entries` answer, still as bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedEntry {
    /// `LedgerKey` XDR.
    pub key: Vec<u8>,
    /// `None` when the network does not have the key.
    pub entry: Option<FetchedBytes>,
    pub live_until: Option<u32>,
}

/// An entry as Go sends it: a whole `LedgerEntry`, or the pieces RPC's
/// `getLedgerEntries` returns (`xdr` is `LedgerEntryData`, plus
/// `lastModifiedLedgerSeq` and `extXdr`), which the lane assembles so Go
/// never builds XDR.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchedBytes {
    Entry(Vec<u8>),
    Data {
        data: Vec<u8>,
        last_modified_ledger_seq: u32,
        ext: Option<Vec<u8>>,
    },
}

/// Why a fetch got no entries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchError {
    /// Go answered with an `error` (`fetch_failed`): `kind` is its
    /// `detail.kind` (`rpc_unavailable`, `timeout`, `rejected`).
    Refused { kind: String, message: String },
    /// Go's answer was not a usable `ledger_entries`.
    BadAnswer(String),
    /// stdin closed or failed while waiting.
    Closed(String),
}

impl FetchError {
    /// The `fetch_failed` `detail.kind` this failure reports as.
    pub fn kind(&self) -> &str {
        match self {
            FetchError::Refused { kind, .. } => kind,
            FetchError::BadAnswer(_) => "rejected",
            FetchError::Closed(_) => "rpc_unavailable",
        }
    }

    pub fn message(&self) -> String {
        match self {
            FetchError::Refused { message, .. } => message.clone(),
            FetchError::BadAnswer(m) => format!("Go's answer to ledger_fetch was unusable: {m}"),
            FetchError::Closed(m) => format!("the CLI went away during ledger_fetch: {m}"),
        }
    }
}

pub struct Channel {
    reader: LineReader<Box<dyn BufRead>>,
    writer: Box<dyn Write>,
    /// Lines read while waiting on a fetch that belong to the main loop.
    deferred: VecDeque<Line>,
    next_fetch: u64,
}

impl Channel {
    pub fn new(reader: Box<dyn BufRead>, writer: Box<dyn Write>, max_line: usize) -> Self {
        Self {
            reader: LineReader::new(reader, max_line),
            writer,
            deferred: VecDeque::new(),
            next_fetch: 0,
        }
    }

    /// The next line for the message loop.
    pub fn next_line(&mut self) -> io::Result<Option<Line>> {
        if let Some(line) = self.deferred.pop_front() {
            return Ok(Some(line));
        }
        self.reader.next_line()
    }

    /// Writes one message as a line and flushes it.
    pub fn send(&mut self, message: &Value) -> io::Result<()> {
        let mut line = serde_json::to_vec(message).map_err(io::Error::other)?;
        line.push(b'\n');
        self.writer.write_all(&line)?;
        self.writer.flush()
    }

    /// Asks Go for `keys` and waits for its answer. Every key asked for comes
    /// back exactly once; a key Go leaves out is treated as absent.
    pub fn fetch(&mut self, keys: &[Vec<u8>]) -> Result<Vec<FetchedEntry>, FetchError> {
        self.next_fetch += 1;
        let id = format!("sim-{}", self.next_fetch);
        let request = json!({
            "version": PROTOCOL_VERSION,
            "id": id,
            "type": "ledger_fetch",
            "keys_xdr": keys.iter().map(|k| BASE64.encode(k)).collect::<Vec<_>>(),
        });
        self.send(&request)
            .map_err(|e| FetchError::Closed(e.to_string()))?;

        loop {
            let line = match self.reader.next_line() {
                Ok(Some(line)) => line,
                Ok(None) => return Err(FetchError::Closed("end of input".into())),
                Err(e) => return Err(FetchError::Closed(e.to_string())),
            };
            let Line::Complete(bytes) = &line else {
                return Err(FetchError::BadAnswer("an oversized line".into()));
            };
            let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
                return Err(FetchError::BadAnswer("a line that is not JSON".into()));
            };
            if value["id"] != Value::String(id.clone()) {
                // Go serialises its requests, so nothing else should arrive
                // mid-fetch; if something does, the loop handles it after.
                self.deferred.push_back(line);
                continue;
            }
            return match value["type"].as_str() {
                Some("ledger_entries") => parse_entries(keys, &value),
                Some("error") => Err(FetchError::Refused {
                    kind: value["detail"]["kind"]
                        .as_str()
                        .unwrap_or("rejected")
                        .to_string(),
                    message: value["message"]
                        .as_str()
                        .unwrap_or("fetch failed")
                        .to_string(),
                }),
                other => Err(FetchError::BadAnswer(format!(
                    "a `{}` message",
                    other.unwrap_or("untyped")
                ))),
            };
        }
    }
}

fn b64(value: &Value, what: &str) -> Result<Vec<u8>, FetchError> {
    let text = value
        .as_str()
        .ok_or_else(|| FetchError::BadAnswer(format!("`{what}` is not a string")))?;
    BASE64
        .decode(text)
        .map_err(|_| FetchError::BadAnswer(format!("`{what}` is not base64")))
}

fn parse_entries(keys: &[Vec<u8>], answer: &Value) -> Result<Vec<FetchedEntry>, FetchError> {
    let Some(items) = answer["entries"].as_array() else {
        return Err(FetchError::BadAnswer("`entries` is not an array".into()));
    };
    let mut out: Vec<FetchedEntry> = keys
        .iter()
        .map(|k| FetchedEntry {
            key: k.clone(),
            entry: None,
            live_until: None,
        })
        .collect();
    for item in items {
        let key = b64(&item["key_xdr"], "key_xdr")?;
        let Some(slot) = out.iter_mut().find(|e| e.key == key) else {
            return Err(FetchError::BadAnswer(
                "an entry for a key that was not asked for".into(),
            ));
        };
        let live_until = item["live_until_ledger"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok());
        slot.live_until = live_until;
        slot.entry = if !item["entry_xdr"].is_null() && item.get("entry_xdr").is_some() {
            Some(FetchedBytes::Entry(b64(&item["entry_xdr"], "entry_xdr")?))
        } else if item.get("data_xdr").is_some() && !item["data_xdr"].is_null() {
            let last_modified_ledger_seq = item["last_modified_ledger_seq"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| {
                    FetchError::BadAnswer("`data_xdr` needs `last_modified_ledger_seq`".into())
                })?;
            let ext = match item.get("ext_xdr") {
                None | Some(Value::Null) => None,
                Some(v) => Some(b64(v, "ext_xdr")?),
            };
            Some(FetchedBytes::Data {
                data: b64(&item["data_xdr"], "data_xdr")?,
                last_modified_ledger_seq,
                ext,
            })
        } else {
            None
        };
    }
    Ok(out)
}

/// A writer tests can read back after the channel took ownership of it.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct SharedBuf(pub std::rc::Rc<std::cell::RefCell<Vec<u8>>>);

#[cfg(test)]
impl Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn channel(input: &str) -> (Channel, SharedBuf) {
        let out = SharedBuf::default();
        let ch = Channel::new(
            Box::new(Cursor::new(input.as_bytes().to_vec())),
            Box::new(out.clone()),
            1 << 20,
        );
        (ch, out)
    }

    #[test]
    fn a_fetch_sends_ledger_fetch_and_reads_the_answer() {
        let (mut ch, out) = channel(concat!(
            r#"{"version":1,"id":"sim-1","type":"ledger_entries","entries":[{"key_xdr":"AAAA","entry_xdr":"BBBB","live_until_ledger":9}]}"#,
            "\n"
        ));
        let got = ch.fetch(&[vec![0, 0, 0], vec![1]]).unwrap();
        assert_eq!(got[0].entry, Some(FetchedBytes::Entry(vec![4, 16, 65])));
        assert_eq!(got[0].live_until, Some(9));
        // A key Go left out is absent.
        assert_eq!(got[1].entry, None);
        let sent: Value = serde_json::from_slice(&out.0.borrow()).unwrap();
        assert_eq!(sent["type"], "ledger_fetch");
        assert_eq!(sent["id"], "sim-1");
        assert_eq!(sent["keys_xdr"], json!(["AAAA", "AQ=="]));
    }

    #[test]
    fn rpc_shaped_entries_are_kept_as_pieces() {
        let (mut ch, _) = channel(concat!(
            r#"{"version":1,"id":"sim-1","type":"ledger_entries","entries":[{"key_xdr":"AAAA","data_xdr":"BBBB","last_modified_ledger_seq":7,"ext_xdr":"AAAAAA=="}]}"#,
            "\n"
        ));
        let got = ch.fetch(&[vec![0, 0, 0]]).unwrap();
        assert_eq!(
            got[0].entry,
            Some(FetchedBytes::Data {
                data: vec![4, 16, 65],
                last_modified_ledger_seq: 7,
                ext: Some(vec![0, 0, 0, 0]),
            })
        );
    }

    #[test]
    fn go_refusing_a_fetch_carries_its_kind() {
        let (mut ch, _) = channel(concat!(
            r#"{"version":1,"id":"sim-1","type":"error","code":"fetch_failed","message":"rpc down","detail":{"kind":"rpc_unavailable"}}"#,
            "\n"
        ));
        let err = ch.fetch(&[vec![0]]).unwrap_err();
        assert_eq!(err.kind(), "rpc_unavailable");
        assert_eq!(err.message(), "rpc down");
    }

    #[test]
    fn an_unrelated_line_mid_fetch_is_kept_for_the_loop() {
        let (mut ch, _) = channel(concat!(
            r#"{"version":1,"id":"r9","type":"status"}"#,
            "\n",
            r#"{"version":1,"id":"sim-1","type":"ledger_entries","entries":[]}"#,
            "\n"
        ));
        ch.fetch(&[vec![0]]).unwrap();
        let Some(Line::Complete(next)) = ch.next_line().unwrap() else {
            panic!("the deferred line is gone")
        };
        assert!(String::from_utf8(next).unwrap().contains("\"r9\""));
    }

    #[test]
    fn end_of_input_mid_fetch_is_closed() {
        let (mut ch, _) = channel("");
        assert!(matches!(ch.fetch(&[vec![0]]), Err(FetchError::Closed(_))));
    }
}
