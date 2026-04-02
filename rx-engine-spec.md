# PharmIDE Rx Engine — Implementation Spec

> Hand this to Claude Code. It describes exactly what to build.
> Read CLAUDE.md first for project context.

---

## Overview

Build the prescription management engine: the system that tracks every prescription through the pharmacy workflow, assigns Rx numbers, manages state transitions, logs every action, and tells the frontend where each script is.

Three pieces, built together:
1. **Rx Numbering System** — mints unique Rx numbers based on drug schedule
2. **Rx State Machine** — manages where a prescription is in the workflow
3. **Event Log** — append-only audit trail of every action

---

## 1. Rx Numbering System

### Rules
- Schedule II drugs: leading `2`, ascending → `200001`, `200002`, `200003`...
- Schedule III-V drugs: leading `3`, ascending → `300001`, `300002`, `300003`...
- Non-controlled drugs: leading `7`, ascending → `700001`, `700002`, `700003`...
- Three independent counters, one per prefix
- Number is assigned **at RPH approval** (not at intake) — don't waste numbers on rejected scripts
- Numbers only grow. No rollover, no gaps, no reuse.
- No dashes or separators. Just `200001` as a plain integer-like string.

### Storage (SQLite)

```sql
CREATE TABLE rx_counters (
    schedule_prefix INTEGER PRIMARY KEY,  -- 2, 3, or 7
    next_number INTEGER NOT NULL DEFAULT 1
);

INSERT INTO rx_counters VALUES (2, 1);
INSERT INTO rx_counters VALUES (3, 1);
INSERT INTO rx_counters VALUES (7, 1);
```

### Rust Command: `mint_rx_number`

```
Input:  schedule_class: String  ("c2", "c3-5", "general")
Output: String                  ("200001")

Logic:
1. Map schedule_class to prefix (c2→2, c3-5→3, general→7)
2. BEGIN TRANSACTION
3. SELECT next_number FROM rx_counters WHERE schedule_prefix = ?
4. Compute rx_number = format!("{}{:05}", prefix, next_number)
5. UPDATE rx_counters SET next_number = next_number + 1 WHERE schedule_prefix = ?
6. COMMIT
7. Return rx_number
```

Atomic transaction — two techs submitting simultaneously will never get the same number.

---

## 2. Rx State Machine

### States (linear pipeline with one branch)

```
INCOMING → ENTRY → RPH_REVIEW → FILL → FILL_VERIFY → READY
                       ↓
                   RETURNED (dead end, can be resubmitted as new ENTRY)
                       ↓
                   CALL_PRESCRIBER (hold state, returns to RPH_REVIEW)
```

### Status Values

| Status | Meaning | Who acts next |
|--------|---------|---------------|
| `incoming` | e-script received, not yet touched | Tech |
| `in_entry` | Tech is transcribing/entering | Tech |
| `pending_review` | Submitted for pharmacist review | RPh |
| `returned` | RPh sent back to tech (needs correction) | Tech |
| `call_prescriber` | RPh needs clarification from prescriber | RPh/Tech |
| `approved` | RPh approved, Rx number minted, ready to fill | Tech |
| `in_fill` | Tech is filling (scanning NDC, counting, labeling) | Tech |
| `pending_fill_verify` | Fill complete, awaiting RPh final check | RPh |
| `ready` | RPh verified fill, ready for patient pickup | Done |

### Valid Transitions

```
incoming         → in_entry              (role: tech)
in_entry         → pending_review        (role: tech, action: SUBMIT_RX)
pending_review   → approved              (role: rph, action: RPH_APPROVE) ← Rx number minted HERE
pending_review   → returned              (role: rph, action: RPH_RETURN)
pending_review   → call_prescriber       (role: rph, action: RPH_CALL)
returned         → pending_review        (role: tech, action: RESUBMIT_RX)
call_prescriber  → pending_review        (role: rph, action: RESOLVE_CALL)
approved         → in_fill               (role: tech, action: START_FILL)
in_fill          → pending_fill_verify   (role: tech, action: SUBMIT_FILL)
pending_fill_verify → ready              (role: rph, action: RPH_VERIFY_FILL)
pending_fill_verify → in_fill            (role: rph, action: RPH_REJECT_FILL)
```

### Rust Command: `transition_rx`

```
Input:
  rx_id: String           -- internal ID (UUID or similar, NOT the Rx number)
  action: String          -- e.g. "RPH_APPROVE"
  actor_id: String        -- who is doing this
  actor_role: String      -- "tech" or "rph"
  payload: String (JSON)  -- any additional data for this action

Output:
  Result with new status, or error if transition is invalid

Logic:
1. Look up current status of rx_id
2. Check if (current_status, action, actor_role) is a valid transition
3. If action == "RPH_APPROVE":
   a. Determine drug schedule from prescription data
   b. Call mint_rx_number(schedule_class)
   c. Attach rx_number to the prescription record
4. Update prescription status to new_status
5. Write event to event_log (see section 3)
6. Return { rx_id, old_status, new_status, rx_number (if minted), timestamp }
```

### Prescription Record (SQLite)

```sql
CREATE TABLE prescriptions (
    id TEXT PRIMARY KEY,              -- internal UUID
    rx_number TEXT UNIQUE,            -- NULL until RPH_APPROVE, then "200001" etc.
    patient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'incoming',
    schedule_class TEXT,              -- "c2", "c3-5", "general"
    
    -- Data accumulates through pipeline
    eorder_data TEXT,                 -- JSON: parsed incoming e-script
    tech_entry_data TEXT,             -- JSON: what tech entered
    rph_review_data TEXT,             -- JSON: pharmacist review notes/decisions
    fill_data TEXT,                   -- JSON: NDC scanned, qty counted, lot, expiry
    rph_fill_review_data TEXT,        -- JSON: final verification notes
    
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);

CREATE INDEX idx_rx_patient ON prescriptions(patient_id);
CREATE INDEX idx_rx_status ON prescriptions(status);
CREATE INDEX idx_rx_number ON prescriptions(rx_number);
```

---

## 3. Event Log (Append-Only Audit Trail)

### Storage

```sql
CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    event_type TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    rx_id TEXT,
    patient_id TEXT,
    rx_number TEXT,
    old_status TEXT,
    new_status TEXT,
    payload TEXT,                      -- JSON: action-specific data
    
    -- NEVER UPDATE OR DELETE FROM THIS TABLE
    CHECK (id > 0)
);

CREATE INDEX idx_event_rx ON event_log(rx_id);
CREATE INDEX idx_event_patient ON event_log(patient_id);
CREATE INDEX idx_event_timestamp ON event_log(timestamp);
CREATE INDEX idx_event_type ON event_log(event_type);
```

### Event Types

| event_type | action | Triggered by |
|-----------|--------|--------------|
| `rx:created` | `CREATE` | New e-script received |
| `rx:entry_started` | `START_ENTRY` | Tech opens script for entry |
| `rx:submitted` | `SUBMIT_RX` | Tech submits for review |
| `rx:approved` | `RPH_APPROVE` | RPh approves (number minted) |
| `rx:returned` | `RPH_RETURN` | RPh returns to tech |
| `rx:call_prescriber` | `RPH_CALL` | RPh flags for prescriber call |
| `rx:resubmitted` | `RESUBMIT_RX` | Tech resubmits after correction |
| `rx:call_resolved` | `RESOLVE_CALL` | Prescriber call resolved |
| `rx:fill_started` | `START_FILL` | Tech starts filling |
| `rx:fill_submitted` | `SUBMIT_FILL` | Tech submits fill for verify |
| `rx:fill_verified` | `RPH_VERIFY_FILL` | RPh approves fill |
| `rx:fill_rejected` | `RPH_REJECT_FILL` | RPh rejects fill |

### Rust Command: `log_event`

```
Input:
  event_type: String
  action: String
  actor_id: String
  actor_role: String
  rx_id: Option<String>
  patient_id: Option<String>
  rx_number: Option<String>
  old_status: Option<String>
  new_status: Option<String>
  payload: Option<String>

Output: event_id (the auto-incremented ID)

Logic: Single INSERT. That's it. No updates ever.
```

**`transition_rx` calls `log_event` internally** — every state transition automatically creates an audit entry. No separate logging step.

---

## 4. Frontend Integration

### Tauri Commands to Expose

```rust
// Core engine
#[tauri::command] fn create_prescription(patient_id, eorder_data) -> Prescription
#[tauri::command] fn transition_rx(rx_id, action, actor_id, actor_role, payload) -> TransitionResult
#[tauri::command] fn get_prescription(rx_id) -> Prescription
#[tauri::command] fn get_prescriptions_by_patient(patient_id) -> Vec<Prescription>
#[tauri::command] fn get_prescriptions_by_status(status) -> Vec<Prescription>

// Event log queries
#[tauri::command] fn get_events_by_rx(rx_id) -> Vec<Event>
#[tauri::command] fn get_events_by_date_range(start, end) -> Vec<Event>

// Queue data (for the pipeline bar)
#[tauri::command] fn get_queue_counts() -> HashMap<String, i32>  
// Returns: { "incoming": 3, "pending_review": 5, "approved": 2, "in_fill": 1, ... }
```

### React Side

The frontend calls these Tauri commands through the existing `TauriDataProvider` pattern. When `transition_rx` returns successfully, the React state updates to reflect the new status. The queue bar re-renders. The workspace panels show/hide based on the new state.

Example flow in React:
```javascript
// Tech hits "Submit for Review" button in RxEntry panel
const result = await invoke('transition_rx', {
  rxId: prescription.id,
  action: 'SUBMIT_RX',
  actorId: currentUser.id,
  actorRole: 'tech',
  payload: JSON.stringify(entryFormData)
});

// result = { rx_id, old_status: "in_entry", new_status: "pending_review", timestamp }
// Update local state, queue bar moves this Rx to the review lane
```

---

## 5. Database Setup

All tables go in the **read-write** database (likely `inventory.db` or a new `pharmide.db`). NOT in `drug_tree.db` which is read-only.

### Migration / Init

Create a Rust function that runs on app startup to ensure tables exist:

```sql
-- Run these as IF NOT EXISTS on startup
CREATE TABLE IF NOT EXISTS rx_counters (...);
CREATE TABLE IF NOT EXISTS prescriptions (...);
CREATE TABLE IF NOT EXISTS event_log (...);

-- Seed counters if empty
INSERT OR IGNORE INTO rx_counters VALUES (2, 1);
INSERT OR IGNORE INTO rx_counters VALUES (3, 1);
INSERT OR IGNORE INTO rx_counters VALUES (7, 1);
```

Enable WAL mode for concurrent read/write:
```sql
PRAGMA journal_mode=WAL;
```

---

## 6. Important Constraints

- **event_log is APPEND ONLY.** No UPDATE. No DELETE. Ever. This is the regulatory audit trail.
- **rx_number is only assigned at RPH_APPROVE.** Before that, the prescription exists by its internal UUID only.
- **Transitions are role-gated.** A tech cannot approve. A pharmacist doesn't fill. The state machine enforces this.
- **Every transition writes to event_log.** This is not optional. The transition function does both atomically.
- **WAL mode on SQLite.** Readers don't block writers. End-of-day reports don't freeze the system.

---

## Build Order

1. Database tables + migration function (run on startup)
2. `mint_rx_number` command
3. `create_prescription` command  
4. `transition_rx` command (includes calling mint + log_event internally)
5. Query commands (get by patient, get by status, get events)
6. Wire up to React: submit buttons call transition_rx, queue bar calls get_queue_counts
