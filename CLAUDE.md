# CLAUDE.md — PharmIDE

## What This App Is

PharmIDE is a Tauri v2 desktop application for pharmacy workflow management. It models the full prescription lifecycle inside a spatial, patient-centric workspace interface.

---

## Core UX Concept: Patient-as-Workspace

**The patient is the unit of work, not the task.**

When a tech opens a patient from the incoming e-order queue, that patient gets their own independent workspace. A workspace contains a set of panels (tabs) covering every stage of the prescription workflow and contextual patient information. Panels are rendered as draggable, resizable tiles on a 12×8 grid.

Each workspace holds:
| Panel Type | Label | Role | Purpose |
|-----------|-------|------|---------|
| `RX_ENTRY` | New Rx | Tech/RPh | Enter prescription from incoming e-order |
| `RPH_VERIFY` | RPh Verify | Pharmacist | Review and verify the entered Rx |
| `FILL` | Fill | Tech/RPh | Scan NDC barcode, confirm quantity |
| `FILL_VERIFY` | Fill Verify | Pharmacist | Final check before pickup |
| `SOLD` | Dispensed | Any | Terminal confirmation panel — shown automatically after SELL_RX |
| `PATIENT_PROFILE` | Profile | Any | Patient demographics — fully editable, saves to pharmide.db |
| `MED_HISTORY` | Med History | Info | Real fill history from `fill_history` table (append-only) |
| `INSURANCE` | Insurance | Info | Insurance and billing details |
| `ALLERGIES` | Allergies | Safety | Allergy warnings (surfaced in red) |
| `NOTES` | Notes | Info | Patient special notes |
| `RX_HISTORY` | Rx History | Any | All prescriptions sorted numerically by Rx# |
| `INVENTORY` | Inventory | Tech | Pharmacy inventory management |
| `PICKUP` | Pickup | Tech | Search by name/DOB, dispense `ready` prescriptions (SELL_RX → `sold`) |
| `PRESCRIBER_DIR` | Prescribers | Any | Two-panel prescriber directory — search/list left, editable profile right |
| `PRESCRIBER_CARD` | Prescriber | Any | Compact in-patient tile showing live prescriber data from store |

Tabs can be detached and dragged to new tiles. Tiles snap to a 12×8 grid at predefined sizes (full, half, quarter, third). Multiple workspaces can be open simultaneously as color-coded tabs.

**Task workspaces** (no patient) are opened via toolbar buttons. Current task types: `inventory` (teal `#14b8a6`), `rx_history` (violet `#a78bfa`), `pickup` (sky `#38bdf8`), `prescriber_dir` (purple `#c084fc`).

---

## Prescription Workflow Pipeline

Every prescription moves through a linear state machine enforced by the Rust backend (`rx_engine.rs`):

```
[E-Order Arrives] → status: null (incoming)
      ↓  START_ENTRY
   in_entry          Tech opens workspace, begins data entry
      ↓  SUBMIT_RX
pending_review        Awaiting RPh review
      ↓
  ┌───┴──────────────────────────────┐
RPH_APPROVE       RPH_RETURN         RPH_CALL
approved          returned           call_prescriber
  ↓             (RESUBMIT_RX)       (RESOLVE_CALL → pending_review)
  START_FILL
  in_fill           Tech filling the prescription
      ↓  SUBMIT_FILL
pending_fill_verify   Awaiting RPh fill check
      ↓
  ┌───┴──────────────┐
RPH_VERIFY_FILL   RPH_REJECT_FILL
ready             (back to in_fill)
      ↓  SELL_RX
    sold              Terminal — prescription dispensed, removed from workflow
                      → SELL_RX reducer routes patient workspace to SOLD tab
```

### Rx Status Values (canonical)

| Status | Meaning |
|--------|---------|
| `null` / `"incoming"` | Arrived, not yet opened |
| `"in_entry"` | Tech actively entering |
| `"pending_review"` | Awaiting RPh review |
| `"approved"` | RPh approved, ready to fill |
| `"returned"` | RPh returned for correction |
| `"call_prescriber"` | Awaiting prescriber contact |
| `"in_fill"` | Tech actively filling |
| `"pending_fill_verify"` | Fill submitted, awaiting RPh |
| `"ready"` | Complete, ready for pickup |
| `"sold"` | Dispensed — terminal state, removed from queue |

**Do not use old status strings**: `in_review`, `filling`, `fill_review`, `filled` — these are retired.

### Rx Numbering

Assigned at `RPH_APPROVE` only. Format: `{prefix}{5-digit sequence}`:
- C-II (schedule 2): `2xxxxx`
- C-III–V (schedule 3–5): `3xxxxx`
- General (non-controlled): `7xxxxx`

`rx_number` is `null` until `RPH_APPROVE`. All display sites must guard: `{rx.rxNumber ? \`Rx# ${rx.rxNumber} · \` : ""}`.

### Role-Based Permissions

**RPh inherits all tech permissions** — this matches real pharmacy practice.

- **Tech**: `SUBMIT_RX`, `RESUBMIT_RX`, `RESET_RX`, `START_FILL`, `SUBMIT_FILL`, `SELL_RX`, `CREATE_WORKSPACE`, panels: `rx_entry`, `fill`
- **RPh**: all of the above, plus `RPH_APPROVE`, `RPH_RETURN`, `RPH_CALL`, `RESOLVE_CALL`, `RPH_VERIFY_FILL`, `RPH_REJECT_FILL`, panels: `rph_verify`, `fill_verify`

Enforced in both frontend (`canDo()` in `PharmIDE.jsx`) and backend (`validate_transition()` in `rx_engine.rs`, where `is_tech = actor_role == "tech" || actor_role == "rph"`).

### Queue Bar

A horizontal pipeline bar at the bottom of the screen groups all open Rxs by status lane. Cards are color-coded by DEA schedule and age in queue. Clicking a card navigates to that patient's workspace. Prescriptions with status `"sold"` are excluded from all lanes.

### SELL_RX Routing

When `dispatch({ type: "SELL_RX", rxId })` fires, the reducer:
1. Marks `ws.rxPrescription.status = "sold"` in the patient workspace
2. Finds the `SOLD` tab in `ws.tabs` (always present — added at workspace creation)
3. Switches the workspace tile's `activeTabId` to the SOLD tab
4. Sets `activePageId` to the patient workspace's page (navigates there)

`SoldContent` renders a green "✓ Dispensed" confirmation with drug, Rx#, qty, prescriber, and dispensing time — read from `workspace.rxPrescription`. If the rx status isn't `"sold"` yet, it shows "Not yet dispensed."

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React v19 (JavaScript/JSX — no TypeScript) |
| Build | Vite v7 |
| Desktop | Tauri v2 |
| Backend | Rust (Tauri commands) |
| Database | SQLite via rusqlite |
| Lint | ESLint v9 |

---

## Key Commands

```bash
npm run tauri dev       # Full dev (Vite + Tauri/Rust hot reload)
npm run dev             # Frontend-only dev server (no Rust)
npm run lint            # ESLint
npm run tauri build     # Production build (Windows WIX installer)
```

---

## Project Structure

```
pharmide/
├── index.html
├── vite.config.js
├── eslint.config.js
├── src/
│   ├── PharmIDE.jsx            # Entire frontend (~6,000+ lines)
│   ├── InventoryWorkspace.jsx  # Inventory management UI
│   ├── TauriDataProvider.js    # Bridges React → Tauri IPC commands
│   └── index.css
└── src-tauri/
    ├── tauri.conf.json         # App config (name, window 1440×900, bundle, WIX)
    ├── Cargo.toml              # uuid = { version = "1", features = ["v4"] }
    └── src/
        ├── lib.rs              # App init, all DB loading, command registration
        ├── main.rs
        ├── db.rs               # drug_tree.db connection
        ├── models.rs
        ├── app_db.rs           # Shared pharmide.db connection (OnceLock<Mutex<Connection>>)
        └── commands/
            ├── drug_search.rs  # Drug query commands (search, NDC lookup, drug tree)
            ├── inventory.rs    # Inventory CRUD (get, update, adjust_on_hand)
            ├── rx_engine.rs    # Prescriptions, state machine, event log, users, Rx#, prescribers, fill_history
            ├── patients.rs     # Patient CRUD (get, upsert, get_all, search)
            └── ai.rs           # Claude Haiku e-script generator (server-side API call)
```

---

## Databases

All initialized in `lib.rs` on startup. All use WAL mode + foreign keys.

| File | Access | Purpose |
|------|--------|---------|
| `drug_tree.db` | Read-only | FDA drug reference (bundled in resources/) |
| `inventory.db` | Read-write | Pharmacy inventory |
| `pharmide.db` | Read-write | Prescriptions, event log, Rx counters, users, prescribers, **patients**, **fill_history** |

`patients.db` has been removed — patients and fill_history tables now live in `pharmide.db` (v6 migration). The shared connection is owned by `src-tauri/src/app_db.rs`.

### pharmide.db Schema Versioning

`pharmide.db` uses `PRAGMA user_version` for incremental migrations inside `init_pharmide_db`:

| Version | Change |
|---------|--------|
| 1–3 | Prescriptions, events, Rx counters, users |
| 4 | `prescribers` table + seed (6 default prescribers with IDs `pres-1`–`pres-6`) |
| 5 | Seed Dr. Claude Haiku, LLMD (`pres-haiku`) |
| 6 | `patients` table (moved from patients.db) + `fill_history` table (append-only dispensing records) |

**Migration pattern**: `if version < N { conn.execute_batch("...ALTER/CREATE...; PRAGMA user_version = N;") }` — always use `INSERT OR IGNORE` for seed data so re-runs are safe.

### `drug_tree.db` — NDC Format

The NDC table has **two NDC columns**:

| Column | Format | Example | Notes |
|--------|--------|---------|-------|
| `ndc_code` | 4-4-2, no leading zero | `"0093-2267-01"` | Display label only |
| `ndc_11` | Plain 11-digit, leading zero padded | `"00093226701"` | **Use this for all lookups** |

**Always query against `ndc_11`.** Strip all non-digits from user input, zero-pad to 11 digits, then `WHERE ndc_11 = ?`. This handles all input variants: `00093-2267-01`, `0093-2267-01`, `00093226701`, `0093226701` — all map to the same `ndc_11` value.

```rust
// In lookup_ndc (drug_search.rs):
let digits: String = ndc.chars().filter(|c| c.is_ascii_digit()).collect();
let ndc_11 = format!("{:0>11}", &digits);
// WHERE n.ndc_11 = ?1
```

Never use `REPLACE(ndc_code, '-', '')` for matching — `ndc_code` is 10 digits (no leading zero) and will not equal an 11-digit user input.

### Rust DB Pattern

The single writable DB connection is owned by `src-tauri/src/app_db.rs`:
```rust
// app_db.rs — the only OnceLock for pharmide.db
static APP_DB: OnceLock<Mutex<Connection>> = OnceLock::new();
pub fn get_conn() -> MutexGuard<'static, Connection> { ... }
pub fn init(path: &str) -> Result<(), String> { ... }
```

All command modules access it via a local `fn get_db()` shim:
```rust
fn get_db() -> std::sync::MutexGuard<'static, Connection> {
    crate::app_db::get_conn()
}
```

**Critical**: Never call `get_db()` from within a function that already holds the lock — this deadlocks. If a command needs to query after writing, do the read inline using the existing `conn`, not by calling another command.

---

## Architecture

### Reactive Data Layer (`DataProvider` / `useData`)

Patient (and future entity) data lives in a dedicated store separate from UI state.

**Two contexts, two concerns:**
- `PharmIDEContext` — UI state: workspaces, tiles, pages, layout, active page
- `DataContext` — Entity data: patients, prescriptions, prescribers, inventory

```javascript
// Reading patient data in any component:
const { getEntity } = useData();
const patient = getEntity('patient', patientId);

// Updating patient data (persists to DB + updates store → all subscribers re-render):
const { updateEntity } = useData();
await updateEntity('patient', patientId, { name: 'New Name' });
```

`DataProvider` wraps the entire app (inside `PharmIDEContext.Provider`). It seeds `store.patients` from `MOCK_PATIENTS` on mount, and merges DB records in when workspaces open.

**Key rule**: Never copy entity fields into another entity or local state for rendering. Components read from the store. One update → everything re-renders. This is why patient name changes now propagate instantly to tile headers, queue bar, page strip, and search.

**`updateEntity(type, id, changes)`** — frontend merges changes with current store entity, dispatches `ENTITY_UPDATED`, and persists to DB:
- `'patient'` → calls `upsertPatient`
- `'prescriber'` → calls `upsertPrescriber` (persists to `pharmide.db` prescribers table)

**`sellPrescription(rxId, actorId, actorRole)`** in `TauriDataProvider.js` — reuses `transition_rx` with action `"SELL_RX"`. No new Rust command needed; the `SELL_RX → sold` transition is registered in `validate_transition()` in `rx_engine.rs`.

**`PatientName` component** — for places inside `PharmIDE`'s own JSX that can't call hooks (e.g., page strip, status bar): `<PatientName patientId={id} />`. Reads from store, reactive.

### `PharmIDE.jsx` Module-Level Constants

```javascript
const T = { ... };                // Dark theme — NOT a hook, accessed directly by closure
const MOCK_PATIENTS = [...];      // Seeded into DataContext store on startup
const QUEUE_LANES = [...];        // Static config
const PRESCRIBER_DATABASE = [...]; // 6 static prescribers (IDs pr001–pr006), seeded into store on mount
const RUNTIME_EORDERS = {};       // Mutable registry — AI-generated e-orders written here at runtime
```

**`PRESCRIBER_DATABASE` vs DB prescribers**: The static array uses IDs `pr001`–`pr006`. The DB seeds the same 6 prescribers with IDs `pres-1`–`pres-6` plus `pres-haiku`. Both are merged into `store.prescribers` — the store will contain entries under both ID sets. Do not deduplicate them; they serve different purposes (static fallback vs persisted records).

**`T` is NOT a hook.** Never write `const T = useTheme()` — `useTheme` does not exist. `T` is a plain `const` at module scope. Access it directly.

### Component Patterns

- **Inline styles** over CSS files — project-wide convention.
- **No component library** — all UI built from scratch.
- **No TypeScript** — do not add `.ts`/`.tsx` files.
- **No test framework** — ESLint only.
- **Never define components inside other components.** Inner function components cause React to unmount/remount on every parent re-render, destroying input focus and local state. Always define components at module level with explicit props.

### Adding a New Tile Type

Checklist:
1. Add to `TAB_TYPES` object
2. Create `XxxContent({ workspace })` function — **at module level**, not inside another component
3. Add `case "XXX": return <XxxContent workspace={workspace} />;` in `TabContent` switch
4. Add to `CREATE_TASK_WORKSPACE` reducer (color + tabType + tab label)
5. Add toolbar button if needed
6. If the tile needs backend data: add method to mock provider (in `PharmIDE.jsx`) **and** `TauriDataProvider.js`; add Rust command in `rx_engine.rs` (or `ai.rs`) and register in `lib.rs`
7. **Do not call `useTheme()` inside the new component** — use `T` directly

### Drug Search in Rx Entry (`DrugSearch` component)

The drug field in `RxEntryContent` uses a custom `DrugSearch` component — **Enter-to-search only** (no live debounce).

**Behavior:**
- User types, nothing fires until Enter is pressed
- If query starts with a digit → NDC lookup path (`getProductByNdc` → `lookup_ndc` Rust command)
  - Single result auto-selects the drug (no picker shown)
  - Returns a synthetic drug object with `_fromNdc: true`, `_ndc`, `_product` fields
- If query starts with a letter → drug name search (`searchDrugs`)
  - Multiple results shown in a scrollable picker list
  - Arrow keys navigate, Enter/click selects

**`searchDrugOrNdc` pattern** in `RxEntryContent`:
```javascript
const searchDrugOrNdc = useCallback(async (query) => {
  if (/^\d/.test(query)) {
    const product = await data.getProductByNdc(query);  // calls lookup_ndc
    if (!product) return [];
    return [{ id: 'ndc-' + digits, _fromNdc: true, _ndc: query, _product: product, ... }];
  }
  return data.searchDrugs(query);
}, [data]);
```

Do **not** use `InlineSearch` (live-debounce) for the drug field — it fires on partial NDC input and returns confusing drug-name results.

### Prescriber Entity System

Prescribers are a first-class reactive entity persisted in `pharmide.db`.

**Rust commands** (in `rx_engine.rs`):
- `get_all_prescribers` → `Vec<Prescriber>`
- `get_prescriber(id)` → `Option<Prescriber>`
- `search_prescribers_db(query)` → `Vec<Prescriber>` (LIKE match on name, DEA, NPI, practice; limit 20)
- `upsert_prescriber(prescriber)` → `Prescriber` — auto-detects last name change

**Name-change tracking**: If `upsert_prescriber` detects `last_name` changed and `former_last_name` is currently NULL, it automatically sets `former_last_name = old last_name` and `name_changed_at = now`. This is preserved across subsequent upserts via `COALESCE`.

**UI surfaces for name changes**:
- `PrescriberDirectoryContent` — amber banner when `formerLastName` is set
- `RphVerifyContent` — amber notice above comparison table
- `RxHistoryContent` — amber "Name changed" badge per affected Rx row

**`DataContext` API**:
```javascript
const { searchPrescribers, getPrescriberById } = useData();
// searchPrescribers(query) — reactive, reads from store.prescribers, min 2 chars, returns up to 10
// getPrescriberById(id) — reactive lookup
```

**Store seeding order**:
1. `PRESCRIBER_DATABASE` (static, 6 prescribers) seeded on mount
2. DB records fetched and merged on mount
3. DB records refreshed again after login in `AppStartup`

### E-Script Generator (`EScriptGeneratorPanel`)

A toolbar button (⚡ E-Scripts) opens a collapsible panel. It calls the Rust `generate_escripts` command (`ai.rs`) which makes a server-side request to the Anthropic API (avoids CORS). Results are written to `RUNTIME_EORDERS` and dispatched to the store.

**The AI model (Claude Haiku) is instructed via system prompt to always prescribe as Dr. Claude Haiku, LLMD at Anthropic** — both in the system prompt and in the hardcoded JSON schema shape passed in the user prompt. Never change this without intent.

Dr. Claude Haiku is seeded in the DB as `pres-haiku`:
- `firstName: "Claude"`, `lastName: "Haiku"`, `credentials: "LLMD"`
- `dea: "NONE"`, `npi: "NONE"`, `practice: "Anthropic"`, `phone: "9709999999"`
- `specialty: "Large Language Prescribing"`

---

## Users

Simple identity system stored in `pharmide.db`. No passwords — users select who they are on login.

Seeded users: `usr-tech-1` (Alex Chen, tech), `usr-tech-2` (Jordan Mills, tech), `usr-rph-1` (Dr. Sarah Park, rph), `usr-rph-2` (Dr. Marcus Webb, rph).

User picker modal shown on app start (`currentUser === null`). Current user shown in top bar with a "switch" link.

---

## Known Patterns and Pitfalls

### Inner Component Anti-Pattern (causes input focus loss)
```javascript
// WRONG — Section is recreated as a new type on every render
function PatientProfile() {
  function Section({ title }) { ... }  // ← never do this
  return <Section title="Demographics" />;
}

// CORRECT — defined at module level
function ProfileSection({ title, children }) { ... }
function PatientProfile() {
  return <ProfileSection title="Demographics" />;
}
```

### Rx Number Null Guard
`rx_number` is `null` until `RPH_APPROVE`. Guard every display:
```javascript
{rx.rxNumber ? `Rx# ${rx.rxNumber} · ` : ""}
```

### Prescription Field Names (canonical)

Stored as JSON strings in SQLite; parsed to objects in UI state and store:

| Field | Meaning |
|-------|---------|
| `techEntryData` | Tech's entry data (drug, sig, qty, prescriber, etc.) |
| `rphReviewData` | RPh review/decision object |
| `rphFillReviewData` | RPh fill verification object |
| `fillData` | Fill scan data (NDC, quantity confirmed) |

**Do not use the old names** `techEntry`, `rphReview`, `rphFillReview` — these were renamed for spec alignment.

### Mutex Deadlock in Rust
If a Tauri command holds the DB lock and calls another function that also calls `get_db()`, it deadlocks forever. Fix: inline the follow-up query using the existing `conn`.

---

## Important Notes

- **`App.jsx` and `App.css`** are unused Vite template remnants — ignore them.
- **App ID**: `com.pharmide.app` | **Window**: 1440×900 (min 1024×700) | **Target**: Windows primary.
- ESLint rule: uppercase variable names may be unused without warning (used for constants/enums).
- The `QueueBar` component receives `state` as a prop (not via context) — it also calls `useData()` for entity lookups.
