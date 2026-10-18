//! NDJSON line framing for the stdio protocol (docs/CLI_RUST_BRIDGE.md §1).
//!
//! A line reader with a hard maximum length. A line over the limit is never
//! buffered past the limit: the reader drops the bytes up to the next newline
//! and reports [`Line::TooLong`], so the stream resynchronises on the next
//! line instead of wedging or growing without bound.

use std::io::{self, BufRead, ErrorKind};

/// Default maximum line length: `contract_install` carries a whole WASM and
/// `ledger_import` a whole snapshot.
pub const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// One framed line, without its terminator.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// The bytes of a line within the length limit (not necessarily UTF-8).
    Complete(Vec<u8>),
    /// A line longer than the limit; its bytes were discarded.
    TooLong,
}

pub struct LineReader<R> {
    inner: R,
    max: usize,
}

impl<R: BufRead> LineReader<R> {
    pub fn new(inner: R, max: usize) -> Self {
        Self { inner, max }
    }

    /// The next line, or `None` at end of input. A final line with no
    /// trailing newline is still returned.
    pub fn next_line(&mut self) -> io::Result<Option<Line>> {
        let mut buf = Vec::new();
        let mut too_long = false;
        loop {
            let chunk = match self.inner.fill_buf() {
                Ok(chunk) => chunk,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if chunk.is_empty() {
                return Ok(if too_long {
                    Some(Line::TooLong)
                } else if buf.is_empty() {
                    None
                } else {
                    Some(Line::Complete(buf))
                });
            }
            let newline = chunk.iter().position(|&b| b == b'\n');
            let content = &chunk[..newline.unwrap_or(chunk.len())];
            let consumed = newline.map_or(chunk.len(), |i| i + 1);
            if !too_long {
                if buf.len() + content.len() > self.max {
                    too_long = true;
                    buf = Vec::new();
                } else {
                    buf.extend_from_slice(content);
                }
            }
            self.inner.consume(consumed);
            if newline.is_some() {
                if too_long {
                    return Ok(Some(Line::TooLong));
                }
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
                return Ok(Some(Line::Complete(buf)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn lines(input: &[u8], max: usize) -> Vec<Line> {
        let mut reader = LineReader::new(Cursor::new(input.to_vec()), max);
        let mut out = Vec::new();
        while let Some(line) = reader.next_line().unwrap() {
            out.push(line);
        }
        out
    }

    fn complete(s: &str) -> Line {
        Line::Complete(s.as_bytes().to_vec())
    }

    #[test]
    fn splits_on_newlines_and_keeps_an_unterminated_tail() {
        assert_eq!(
            lines(b"a\nbc\nd", 16),
            [complete("a"), complete("bc"), complete("d")]
        );
    }

    #[test]
    fn empty_input_has_no_lines_and_empty_lines_are_kept() {
        assert!(lines(b"", 16).is_empty());
        assert_eq!(lines(b"\n", 16), [complete("")]);
    }

    #[test]
    fn strips_a_carriage_return() {
        assert_eq!(lines(b"a\r\nb\n", 16), [complete("a"), complete("b")]);
    }

    #[test]
    fn a_line_at_the_limit_passes_and_one_over_is_too_long() {
        assert_eq!(lines(b"1234\n", 4), [complete("1234")]);
        assert_eq!(lines(b"12345\n", 4), [Line::TooLong]);
    }

    #[test]
    fn resynchronises_at_the_next_newline_after_a_long_line() {
        assert_eq!(
            lines(b"ok\nxxxxxxxxxxxx\nnext\n", 4),
            [complete("ok"), Line::TooLong, complete("next")]
        );
    }

    #[test]
    fn a_long_line_is_detected_across_buffer_refills() {
        let mut input = vec![b'x'; 100];
        input.extend_from_slice(b"\nafter\n");
        let reader = io::BufReader::with_capacity(8, Cursor::new(input));
        let mut reader = LineReader::new(reader, 10);
        assert_eq!(reader.next_line().unwrap(), Some(Line::TooLong));
        assert_eq!(reader.next_line().unwrap(), Some(complete("after")));
        assert_eq!(reader.next_line().unwrap(), None);
    }

    #[test]
    fn an_unterminated_long_tail_is_too_long() {
        assert_eq!(lines(b"ok\nxxxxxxxx", 4), [complete("ok"), Line::TooLong]);
    }
}
