// sys_clock.rs
//
// Single authoritative time source for all audit events.
// Every command that writes to the audit log must use sys_clock::now()
// for timestamps — never JavaScript Date, never SQLite strftime defaults.

use std::sync::OnceLock;
use std::time::Instant;

/// Returns the current UTC timestamp in ISO 8601 format with milliseconds.
/// Format: "2026-02-28T21:45:30.123Z"
pub fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Returns nanoseconds elapsed since the first call to this function.
/// Used as a tiebreaker for events that land in the same millisecond.
/// The absolute value is meaningless — only ordering within a session matters.
pub fn monotonic_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}
