//! The process memory guard (#536).
//!
//! The host meters a call's memory against its budget, which is what the
//! network does and what a `contract_error` reports. This is the backstop
//! for what the budget does not see (a host bug, a lifted budget): every
//! allocation in the process is counted, and one that would take the total
//! past the limit (2 GiB, or `SIGNET_SIMULATOR_MEMORY_LIMIT` bytes) fails.
//!
//! An allocation failure cannot be recovered in Rust: the process aborts.
//! So before failing it the guard writes one protocol line, an `error` with
//! code `resource_limit` and `detail.kind: "memory"`, formatted at startup
//! because the allocator cannot allocate to report itself. Go reads it as
//! the process giving up (its `id` is null), and the next request respawns a
//! fresh simulator (docs/CLI_RUST_BRIDGE.md §4).

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;

use crate::PROTOCOL_VERSION;

pub const DEFAULT_LIMIT: usize = 2 << 30;
pub const LIMIT_ENV: &str = "SIGNET_SIMULATOR_MEMORY_LIMIT";

static USED: AtomicUsize = AtomicUsize::new(0);
static LIMIT: AtomicUsize = AtomicUsize::new(DEFAULT_LIMIT);
static TRIPPED: AtomicBool = AtomicBool::new(false);
static REPORT: OnceLock<Vec<u8>> = OnceLock::new();

/// Reads the limit from the environment and formats the report line. Call
/// once, first thing in `main`.
pub fn configure() {
    if let Some(limit) = std::env::var(LIMIT_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
    {
        LIMIT.store(limit, Ordering::Relaxed);
    }
    let limit = LIMIT.load(Ordering::Relaxed);
    let mut line = serde_json::to_vec(&serde_json::json!({
        "version": PROTOCOL_VERSION,
        "id": null,
        "type": "error",
        "code": "resource_limit",
        "message": format!(
            "the simulator went over its {} MiB memory limit and has to stop; the next request starts a fresh one",
            limit >> 20
        ),
        "detail": { "kind": "memory", "limit": limit },
    }))
    .expect("the report line serialises");
    line.push(b'\n');
    let _ = REPORT.set(line);
}

pub struct Guard;

fn reserve(size: usize) -> bool {
    let total = USED.fetch_add(size, Ordering::Relaxed).saturating_add(size);
    if total > LIMIT.load(Ordering::Relaxed) {
        USED.fetch_sub(size, Ordering::Relaxed);
        trip();
        return false;
    }
    true
}

fn release(size: usize) {
    USED.fetch_sub(size, Ordering::Relaxed);
}

/// Reports, once, that the limit tripped. Nothing here allocates: the line
/// was formatted by `configure`, and stdout's buffer already exists.
fn trip() {
    if TRIPPED.swap(true, Ordering::Relaxed) {
        return;
    }
    if let Some(line) = REPORT.get() {
        let mut out = std::io::stdout();
        let _ = out.write_all(line);
        let _ = out.flush();
    }
    let _ = std::io::stderr().write_all(b"signet-simulator: memory limit reached, stopping\n");
}

unsafe impl GlobalAlloc for Guard {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !reserve(layout.size()) {
            return std::ptr::null_mut();
        }
        let ptr = unsafe { System.alloc(layout) };
        if ptr.is_null() {
            release(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !reserve(layout.size()) {
            return std::ptr::null_mut();
        }
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if ptr.is_null() {
            release(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        release(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old = layout.size();
        if new_size > old && !reserve(new_size - old) {
            return std::ptr::null_mut();
        }
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if new.is_null() {
            if new_size > old {
                release(new_size - old);
            }
        } else if new_size < old {
            release(old - new_size);
        }
        new
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_is_a_resource_limit_error_with_a_null_id() {
        configure();
        let line: serde_json::Value =
            serde_json::from_slice(REPORT.get().unwrap().trim_ascii_end()).unwrap();
        assert_eq!(line["code"], "resource_limit");
        assert_eq!(line["detail"]["kind"], "memory");
        assert_eq!(line["id"], serde_json::Value::Null);
        assert!(line["detail"]["limit"].as_u64().unwrap() > 0);
    }
}
