# PharmIDE Merkle Audit & Time System — Specification

> This is the trust layer. Every regulatory claim the software makes rests on this.
> Build it early, build it right, never change the schema.

---

## Part 1: System Clock

### The Problem

JavaScript `Date.now()` and Rust `SystemTime` can drift, be wrong, or be manipulated. If the app relies on client-side time for audit events, an inspector could question whether timestamps are trustworthy.

### The Solution

A single authoritative time source for all audit events, with drift detection.

### Rust-Side System Clock Module (`sys_clock.rs`)

```rust
/// Returns the current UTC timestamp in ISO 8601 with milliseconds.
/// This is the ONLY function any command should call for audit timestamps.
/// 
/// Format: "2026-02-28T21:45:30.123Z"
pub fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Returns system uptime monotonic counter (nanoseconds).
/// Used for ordering events that happen within the same millisecond.
pub fn monotonic_ns() -> u64 {
    std::time::Instant::now().elapsed().as_nanos() as u64
}
```

### Startup Time Validation

On app launch, before any events are logged:

```rust
/// Called once at startup. Logs a SYSTEM_START event with:
/// - System clock UTC
/// - Timezone offset
/// - OS-reported time
/// - Whether NTP sync is available
/// 
/// If the system clock is obviously wrong (year < 2025 or year > 2030),
/// log a CLOCK_WARNING event and display a warning to the user.
fn validate_system_clock() -> ClockStatus {
    let utc_now = chrono::Utc::now();
    let local_now = chrono::Local::now();
    let offset = local_now.offset().to_string();
    
    let suspicious = utc_now.year() < 2025 || utc_now.year() > 2030;
    
    ClockStatus {
        utc: now(),
        timezone_offset: offset,
        suspicious,
    }
}
```

### Rules

- **All audit timestamps come from Rust `sys_clock::now()`** — never from JavaScript, never from SQLite `strftime`.
- **SQLite `DEFAULT` values on timestamp columns are fallbacks only** — the Rust insert should always supply an explicit timestamp.
- **Frontend displays local time** — convert UTC to local for the UI, but store UTC always.
- **Every session starts with a `SYSTEM_START` event** — establishes the clock baseline for that session.

---

## Part 2: User Session Chain

### On Login

When a user authenticates (selects their identity), the system creates a session:

```
session_id:    "sess-uuid-v4"
user_id:       "usr-rph-1"
started_at:    sys_clock::now()
session_hash:  SHA-256(session_id | user_id | started_at)
```

This `session_hash` is included on every event the user creates during this session. It proves continuous authentication — every action traces back to a specific login moment.

### On Logout / Switch User

```
ended_at:      sys_clock::now()
closing_hash:  SHA-256(session_hash | ended_at | last_event_hash)
```

The closing hash seals the session. It references the last event in the session chain, proving nothing was appended after logout.

### Session Table

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                -- "sess-uuid-v4"
    user_id TEXT NOT NULL,
    user_role TEXT NOT NULL,
    started_at TEXT NOT NULL,           -- UTC from sys_clock
    ended_at TEXT,                      -- NULL while active, set on logout
    session_hash TEXT NOT NULL,         -- SHA-256(id | user_id | started_at)
    closing_hash TEXT,                  -- SHA-256(session_hash | ended_at | last_event_hash)
    
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_session_user ON sessions(user_id);
CREATE INDEX idx_session_time ON sessions(started_at);
```

---

## Part 3: Event Log with Merkle Chain

### What Gets Hashed (Regulatory Events Only)

These events enter the Merkle chain:

| Category | Events |
|----------|--------|
| **Rx Lifecycle** | rx:created, rx:submitted, rx:resubmitted, rx:approved, rx:returned, rx:call_prescriber, rx:call_resolved, rx:fill_started, rx:fill_submitted, rx:fill_verified, rx:fill_rejected, rx:sold |
| **Patient Records** | patient:created, patient:updated (demographics, allergies, insurance changes) |
| **Controlled Substance** | inventory:c2_adjusted, inventory:c2_received, inventory:c2_count |
| **User Sessions** | session:started, session:ended |
| **System** | system:start, system:clock_warning, chain:verified |

### What Does NOT Get Hashed

These are logged to a separate `activity_log` table (no chain, no hash):

- Panel opened / closed / focused
- Tile dragged / resized
- Search queries
- UI navigation
- Debug info

### Event Log Table

```sql
CREATE TABLE event_log (
    -- Identity
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,       -- "evt-uuid-v4" (for cross-referencing)
    
    -- Time
    timestamp TEXT NOT NULL,             -- UTC from sys_clock::now(), NOT sqlite default
    monotonic_ns INTEGER,                -- Ordering tiebreaker for same-millisecond events
    
    -- What happened
    event_type TEXT NOT NULL,            -- "rx:approved", "patient:updated", etc.
    action TEXT NOT NULL,                -- "RPH_APPROVE", "UPDATE", "CREATE", etc.
    
    -- Who did it
    actor_id TEXT NOT NULL,              -- User ID
    actor_role TEXT NOT NULL,            -- "tech", "rph", "system"
    session_id TEXT NOT NULL,            -- Links to sessions table
    session_hash TEXT NOT NULL,          -- Copied from active session for fast verification
    
    -- What it affected
    entity_type TEXT,                    -- "prescription", "patient", "inventory"
    entity_id TEXT,                      -- UUID of the affected entity
    rx_id TEXT,                          -- Shortcut for prescription events
    rx_number TEXT,                      -- If assigned at this point
    patient_id TEXT,                     -- Shortcut for patient context
    
    -- State change
    old_status TEXT,                     -- Previous status (for transitions)
    new_status TEXT,                     -- New status (for transitions)
    
    -- Data
    payload TEXT,                        -- JSON: action-specific data (changes, form data, etc.)
    
    -- Merkle chain
    sequence INTEGER NOT NULL UNIQUE,    -- Monotonically increasing, no gaps allowed
    previous_hash TEXT NOT NULL,         -- Hash of prior event (genesis = 64 zeros)
    event_hash TEXT NOT NULL,            -- SHA-256 of this event's canonical form
    
    -- Constraints
    CHECK (id > 0)
    -- NEVER UPDATE OR DELETE FROM THIS TABLE
);

-- Indexes for common queries
CREATE INDEX idx_event_rx ON event_log(rx_id);
CREATE INDEX idx_event_patient ON event_log(patient_id);
CREATE INDEX idx_event_timestamp ON event_log(timestamp);
CREATE INDEX idx_event_type ON event_log(event_type);
CREATE INDEX idx_event_actor ON event_log(actor_id);
CREATE INDEX idx_event_session ON event_log(session_id);
CREATE INDEX idx_event_sequence ON event_log(sequence);
```

### Activity Log Table (Unhashed, for debugging/analytics)

```sql
CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    user_id TEXT,
    action TEXT NOT NULL,               -- "panel_opened", "search_performed", "tile_resized"
    details TEXT                         -- JSON blob of context
);
```

---

## Part 4: Hash Computation

### Canonical Form

The hash input is a deterministic string built from event fields in a fixed order. This ensures the same event always produces the same hash regardless of JSON key ordering or whitespace.

```
HASH_INPUT = "{sequence}|{event_id}|{timestamp}|{monotonic_ns}|{event_type}|{action}|{actor_id}|{actor_role}|{session_id}|{session_hash}|{entity_type}|{entity_id}|{rx_id}|{rx_number}|{patient_id}|{old_status}|{new_status}|{payload}|{previous_hash}"
```

**Null fields are represented as empty string** — `"field1||field3"` not `"field1|null|field3"`.

**Payload is included as-is** — the raw JSON string, not parsed and re-serialized. This prevents key-ordering differences from changing the hash.

### Hash Algorithm

```rust
use sha2::{Sha256, Digest};

fn compute_event_hash(
    sequence: i64,
    event_id: &str,
    timestamp: &str,
    monotonic_ns: u64,
    event_type: &str,
    action: &str,
    actor_id: &str,
    actor_role: &str,
    session_id: &str,
    session_hash: &str,
    entity_type: &str,    // "" if null
    entity_id: &str,      // "" if null
    rx_id: &str,          // "" if null
    rx_number: &str,      // "" if null
    patient_id: &str,     // "" if null
    old_status: &str,     // "" if null
    new_status: &str,     // "" if null
    payload: &str,        // "" if null
    previous_hash: &str,
) -> String {
    let canonical = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        sequence, event_id, timestamp, monotonic_ns,
        event_type, action, actor_id, actor_role,
        session_id, session_hash,
        entity_type, entity_id, rx_id, rx_number, patient_id,
        old_status, new_status, payload, previous_hash
    );
    
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}
```

### Genesis Event

The very first event in the system (typically `system:start` on first-ever launch):

```
sequence: 1
previous_hash: "0000000000000000000000000000000000000000000000000000000000000000"
event_hash: SHA-256(canonical form with the zero previous_hash)
```

### Insert Flow

Every event insert follows this exact sequence:

```rust
fn log_event(/* all fields */) -> Result<Event> {
    let conn = get_pharmide_db();
    
    // 1. Get the last event's hash and sequence
    let (prev_hash, prev_seq) = conn.query_row(
        "SELECT event_hash, sequence FROM event_log ORDER BY sequence DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    ).unwrap_or((
        "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
        0
    ));
    
    // 2. Assign next sequence number
    let sequence = prev_seq + 1;
    
    // 3. Generate event_id
    let event_id = format!("evt-{}", uuid::Uuid::new_v4());
    
    // 4. Get timestamp from system clock
    let timestamp = sys_clock::now();
    let monotonic = sys_clock::monotonic_ns();
    
    // 5. Compute hash
    let event_hash = compute_event_hash(
        sequence, &event_id, &timestamp, monotonic,
        &event_type, &action, &actor_id, &actor_role,
        &session_id, &session_hash,
        &entity_type, &entity_id, &rx_id, &rx_number, &patient_id,
        &old_status, &new_status, &payload,
        &prev_hash
    );
    
    // 6. Insert (single transaction)
    conn.execute(
        "INSERT INTO event_log (
            event_id, timestamp, monotonic_ns,
            event_type, action, actor_id, actor_role,
            session_id, session_hash,
            entity_type, entity_id, rx_id, rx_number, patient_id,
            old_status, new_status, payload,
            sequence, previous_hash, event_hash
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![
            event_id, timestamp, monotonic,
            event_type, action, actor_id, actor_role,
            session_id, session_hash,
            entity_type, entity_id, rx_id, rx_number, patient_id,
            old_status, new_status, payload,
            sequence, prev_hash, event_hash
        ],
    )?;
    
    // 7. Return the event
    Ok(Event { /* all fields */ })
}
```

**Critical:** Steps 1-6 must be in a single transaction. If two events try to insert simultaneously, the sequence numbers and hash chain must not collide. The `Mutex<Connection>` pattern already ensures this — only one writer at a time.

---

## Part 5: Chain Verification

### `verify_audit_chain` Command

```rust
#[tauri::command]
fn verify_audit_chain(start_seq: Option<i64>, end_seq: Option<i64>) -> ChainVerification {
    let conn = get_pharmide_db();
    
    let mut stmt = conn.prepare(
        "SELECT sequence, event_id, timestamp, monotonic_ns,
                event_type, action, actor_id, actor_role,
                session_id, session_hash,
                entity_type, entity_id, rx_id, rx_number, patient_id,
                old_status, new_status, payload,
                previous_hash, event_hash
         FROM event_log
         WHERE sequence >= ?1 AND sequence <= ?2
         ORDER BY sequence ASC"
    )?;
    
    let start = start_seq.unwrap_or(1);
    let end = end_seq.unwrap_or(i64::MAX);
    
    let mut expected_prev_hash = if start == 1 {
        "0000000000000000000000000000000000000000000000000000000000000000".to_string()
    } else {
        // Fetch the hash of the event just before our start
        conn.query_row(
            "SELECT event_hash FROM event_log WHERE sequence = ?1",
            [start - 1],
            |row| row.get(0)
        )?
    };
    
    let mut checked = 0;
    let mut broken_at = None;
    
    for row in stmt.query_map(params![start, end], |row| { /* map all fields */ })? {
        let event = row?;
        checked += 1;
        
        // Verify previous_hash matches what we expect
        if event.previous_hash != expected_prev_hash {
            broken_at = Some(ChainBreak {
                sequence: event.sequence,
                event_id: event.event_id,
                expected_previous_hash: expected_prev_hash,
                actual_previous_hash: event.previous_hash,
                break_type: "previous_hash_mismatch",
            });
            break;
        }
        
        // Recompute the event hash
        let recomputed = compute_event_hash(/* all fields from event */);
        if recomputed != event.event_hash {
            broken_at = Some(ChainBreak {
                sequence: event.sequence,
                event_id: event.event_id,
                expected_hash: recomputed,
                actual_hash: event.event_hash,
                break_type: "event_hash_mismatch",
            });
            break;
        }
        
        // This event's hash becomes the next event's expected previous_hash
        expected_prev_hash = event.event_hash;
    }
    
    ChainVerification {
        valid: broken_at.is_none(),
        total_checked: checked,
        broken_at,
        verified_at: sys_clock::now(),
    }
}
```

### When to Run Verification

| Trigger | Scope | Blocking? |
|---------|-------|-----------|
| App startup | Full chain | Background (non-blocking), warn if broken |
| Before generating any report | Full chain or date range | Blocking — refuse to generate if chain is broken |
| On demand (admin button) | Full chain | Foreground with progress indicator |
| Before data export | Full chain | Blocking |
| After system crash recovery | Full chain | Foreground |

### Verification Result Display

The UI should show a simple indicator:
- 🟢 **Chain Intact** — "Audit chain verified: 4,287 events, all valid"
- 🔴 **Chain Broken** — "Audit chain broken at event #3,201 (rx:approved, 2026-03-15T14:22:00Z). Contact administrator."

A broken chain is a **serious event**. It means data was tampered with or corrupted. The system should log `chain:verification_failed` (to the activity_log, not the event_log, since the event_log integrity is in question) and prevent report generation until investigated.

---

## Part 6: Report Queries

### Daily Printout (Colorado Rule 11)

```sql
SELECT 
    e.timestamp,
    e.event_type,
    e.action,
    u.name as actor_name,
    e.actor_role,
    e.rx_number,
    e.patient_id,
    e.old_status,
    e.new_status,
    e.payload
FROM event_log e
JOIN users u ON e.actor_id = u.id
WHERE e.timestamp >= ?1 AND e.timestamp < ?2
ORDER BY e.sequence ASC;
```

Run `verify_audit_chain` for the date range first. If intact, generate report. If broken, refuse and flag.

### CII Reconciliation

```sql
SELECT 
    e.timestamp,
    e.action,
    u.name as actor_name,
    e.rx_number,
    e.patient_id,
    e.payload
FROM event_log e
JOIN users u ON e.actor_id = u.id
WHERE e.event_type IN ('rx:approved', 'rx:fill_verified', 'rx:sold')
AND json_extract(e.payload, '$.scheduleClass') = 'c2'
AND e.timestamp >= ?1 AND e.timestamp < ?2
ORDER BY e.sequence ASC;
```

### User Activity Report (Inspector Request)

```sql
SELECT 
    e.timestamp,
    e.event_type,
    e.action,
    e.rx_number,
    e.patient_id,
    e.payload
FROM event_log e
WHERE e.actor_id = ?1
AND e.timestamp >= ?2 AND e.timestamp < ?3
ORDER BY e.sequence ASC;
```

### Full Rx History (Single Prescription)

```sql
SELECT 
    e.timestamp,
    e.event_type,
    e.action,
    u.name as actor_name,
    e.actor_role,
    e.old_status,
    e.new_status,
    e.payload
FROM event_log e
JOIN users u ON e.actor_id = u.id
WHERE e.rx_id = ?1
ORDER BY e.sequence ASC;
```

---

## Part 7: Cargo Dependencies

Add to `Cargo.toml`:

```toml
[dependencies]
sha2 = "0.10"
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }  # Already present
```

---

## Summary of Tables

| Table | Database | Hashed? | Mutable? |
|-------|----------|---------|----------|
| `event_log` | pharmide.db | ✅ Merkle chain | Append-only. NEVER update or delete. |
| `sessions` | pharmide.db | Session hash on create, closing hash on end | Close only (set ended_at + closing_hash) |
| `activity_log` | pharmide.db | ❌ No chain | Append-only but no cryptographic guarantee |
| `prescriptions` | pharmide.db | ❌ (changes logged TO event_log) | Yes, through Rx engine |
| `patients` | patients.db | ❌ (changes logged TO event_log) | Yes, through data layer |
| `rx_counters` | pharmide.db | ❌ | Yes (increment only) |
| `users` | pharmide.db | ❌ | Rarely |
| `inventory` | inventory.db | ❌ (C2 adjustments logged TO event_log) | Yes |

---

## Build Order

1. `sys_clock.rs` — clock module with `now()` and `monotonic_ns()`
2. Add `sha2` and `chrono` to Cargo.toml
3. `sessions` table + login/logout commands
4. `event_log` table with Merkle columns
5. `compute_event_hash` function
6. `log_event` function (with chain computation)
7. `verify_audit_chain` command
8. `activity_log` table (simple, no chain)
9. Wire `log_event` into `transition_rx` and `updateEntity` backend commands
10. Startup: `validate_system_clock` → `system:start` event → `verify_audit_chain` (background)
11. UI: chain status indicator somewhere visible
