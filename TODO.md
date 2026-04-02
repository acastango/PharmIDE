# PharmIDE — Deferred Work

## Step 6 — Inventory Wiring (Partial)

`store.inventory` slot exists. `updateEntity('inventory', id, changes)` already merges into the store. Full wiring blocked by:
- `InventoryWorkspace.jsx` uses its own `invoke` calls (not through DataProvider) — needs to be given `storeDispatch` as a prop or import DataContext directly
- Fill panel NDC lookup needs to dispatch inventory items to store on fetch
- Full implementation is part of Step 8 (Fill panel migration)

---

## Step 7 — Notes Wiring (Deferred)

`store.notes` slot exists. Notes are currently a plain text field on the Patient record (`patient.notes`), not a structured entity. The spec's Note schema (with `noteType`, `authorId`, `rxId`, `timestamp`, append-only) will be implemented when NotesContent is migrated in Step 8.

---

## Step 8 — Panel Migration (Deferred)

Migrate individual panels to read directly from `useData()` store instead of receiving entity data as props or reading from `ws.rxPrescription`:
- `RxEntryContent` — read rx from `getEntity('prescription', rxId)`
- `RphVerifyContent` — read rx + patient + notes from store
- `FillContent` — read rx + `getEntity('inventory', ...)` from store
- `FillVerifyContent` — read rx from store
- `PatientProfileContent` — already migrated ✅
- `RxHistoryContent` — read `getEntities('prescription', { patientId })` from store
- `NotesContent` — read `getEntities('note', { patientId })` from store
- `InventoryWorkspace` — read `getEntities('inventory')` from store

Each panel: remove entity props, call `useData()`, guard for null (entity not yet loaded).

---

## Activity Log Wiring (Deferred)

`activity_log` table exists in `pharmide.db` (created during Merkle audit migration). It is intentionally not wired to any Tauri command yet — UI event noise would clutter the audit implementation.

**What this entails:**
- Add `log_activity(user_id: Option<String>, action: String, details: Option<String>) -> Result<(), String>` command in `rx_engine.rs`
- Register in `lib.rs` handler
- Add `logActivity(action, details)` to `TauriDataProvider.js`
- Call from UI for: panel_opened, search_performed, tile_resized, navigation events

**Why deferred**: Not blocking anything. This is analytics/debugging infrastructure, not regulatory-required. Wire when building the admin/analytics dashboard.

---

## E-Order Ingestion (Backend Ready — Transport Deferred)

The `eorders` table is live in `pharmide.db` (schema version 3). The full ingestion pipeline is wired. UI and backend complete; only the transport layer remains.

**Still needed (transport layer)**
- Ingestion mechanism: file-watch drop folder, TCP/TLS listener, or HTTP webhook calling `ingest_eorder_xml`
- Real SureScripts SOAP/REST or SFTP integration
- Auto patient matching on ingest: look up `pharmide.db` patients table by lastName+DOB, auto-set `patient_id`
- REFILL, ChangeRequest, CancelRx handling (parser detects message type; only NewRx is fully used)

---

## Notes, Insurance, Allergies (Partially Wired)

All three panels read from the patient record object, which **is** persisted to `pharmide.db` (patients table). They function as long as the patient was created/edited via `PatientProfileContent`. However:

- **Notes** — `patient.notes` is a plain string. The spec defines structured append-only Note entities (`noteType`, `authorId`, `rxId`, `timestamp`). The `store.notes` slot exists but is never populated. Tracked in Step 7 above.
- **Insurance** — `patient.insurance` object (plan, memberId, group, copay) is stored as part of the patient JSON. Works once a patient is saved with insurance data. No separate table needed.
- **Allergies** — `patient.allergies[]` array stored on patient record. Works once saved. No separate table needed.

**Action needed for Notes only** — insurance and allergies are functionally complete via the patient record.
