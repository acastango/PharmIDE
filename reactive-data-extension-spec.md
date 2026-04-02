# Reactive Data Layer Extension — All Entity Types

> Claude Code: Read alongside CLAUDE.md and reactive-data-layer-spec.md.
> The DataProvider and useData() pattern already works for patients.
> Extend it to cover every entity type the app touches.

---

## Goal

Every piece of data in the system flows through the same reactive store. When a prescription updates, every component showing that prescription re-renders. When inventory decrements, the fill panel and the inventory panel both reflect it. Same pattern as patients — one source of truth, write-first, no stale copies.

---

## New Entity Types to Add to the Store

Extend `initialStore` in DataProvider:

```javascript
const initialStore = {
  patients: {},          // ✅ Already working
  prescriptions: {},     // 🔨 Add now
  prescribers: {},       // 🔨 Add now
  drugs: {},             // 🔨 Add now (cached drug lookups from drug_tree.db)
  inventory: {},         // 🔨 Add now
  notes: {},             // 🔨 Add now
  users: {},             // ✅ Already seeded on login
};
```

---

## Entity Schemas

### Prescription

The core object that moves through the pipeline. References other entities by ID — never copies their data.

```javascript
{
  id: "rx-uuid-1",                    // Internal UUID (assigned at creation)
  rxNumber: null,                      // Null until RPH_APPROVE, then "700001" etc.
  patientId: "patient-uuid-1",        // → store.patients[patientId]
  prescriberId: "prescriber-uuid-1",  // → store.prescribers[prescriberId]
  status: "pending_review",           // Canonical status from state machine

  // Drug reference
  drugId: "drug-uuid-1",             // → store.drugs[drugId] for display name, class, etc.
  ndc: "12345-678-90",               // Specific NDC selected
  scheduleClass: "general",          // "c2", "c3-5", "general"

  // Rx details
  quantity: 30,
  daysSupply: 30,
  refillsAuthorized: 3,
  refillsUsed: 0,
  directions: "Take 1 tablet by mouth daily",
  daw: 0,                            // Dispense as written code

  // Pipeline data (accumulated, never overwritten)
  eorderData: { ... },               // Parsed incoming e-script (if electronic)
  techEntryData: { ... },            // What the tech entered
  rphReviewData: { ... },            // Pharmacist review notes/decision
  fillData: { ... },                 // NDC scanned, qty counted, lot, expiry
  rphFillReviewData: { ... },        // Final verification notes

  // Timestamps
  createdAt: "2026-02-28T14:30:00.000",
  updatedAt: "2026-02-28T15:12:00.000",
}
```

**Key rule:** Components displaying the drug name on a prescription do:
```javascript
const rx = getEntity('prescription', rxId);
const drug = getEntity('drug', rx.drugId);
// Display drug.name, not a copied string on the prescription
```

Same for prescriber name, patient name, etc.

### Prescriber

```javascript
{
  id: "prescriber-uuid-1",
  firstName: "James",
  lastName: "Wilson",
  npi: "1234567890",                  // National Provider Identifier (10 digits)
  deaNumber: "AW1234567",            // DEA registration number
  phone: "970-555-0100",
  fax: "970-555-0101",
  address: "123 Medical Dr, Fort Collins, CO 80521",
  specialty: "Internal Medicine",
  stateLicense: "CO-12345",
}
```

Prescribers are referenced by prescriptions and displayed in Rx Entry, RPh Verify, and printouts. Creating a new prescriber happens inline during Rx entry when the prescriber isn't already in the system.

### Drug (Cached from drug_tree.db)

```javascript
{
  id: "drug-uuid-1",                 // Or use the drug_tree.db primary key
  name: "Lisinopril",
  strength: "10 mg",
  form: "Tablet",
  route: "Oral",
  deaSchedule: 0,                    // 0 = non-controlled, 2 = CII, 3-5 = CIII-CV
  scheduleClass: "general",          // Derived: "c2", "c3-5", "general"
  genericName: "Lisinopril",
  brandName: "Prinivil",
  ndc: "12345-678-90",               // Default/primary NDC
  drugClass: "ACE Inhibitor",
  // Additional fields from drug tree as needed
}
```

**Note:** drug_tree.db is read-only. These don't get `updateEntity` calls — they get loaded into the store via `loadEntities` when a drug search happens, then stay cached for the session. Think of this as a lookup cache, not a mutable entity.

### Inventory Item

```javascript
{
  id: "inv-uuid-1",
  ndc: "12345-678-90",
  drugName: "Lisinopril 10mg Tablet",  // Denormalized for display (acceptable here since drug_tree is read-only)
  manufacturer: "Lupin",
  qtyOnHand: 120,
  reorderPoint: 50,
  lotNumber: "L2026A",
  expiryDate: "2027-06-30",
  location: "A-3-2",                   // Shelf location
  lastUpdated: "2026-02-28T10:00:00.000",
}
```

When a fill happens and qty decrements, `updateEntity('inventory', invId, { qtyOnHand: newQty })` fires and every component showing that inventory item updates.

### Note

```javascript
{
  id: "note-uuid-1",
  patientId: "patient-uuid-1",
  rxId: "rx-uuid-1",                  // Optional — null for general patient notes
  noteType: "clinical",               // "clinical", "insurance", "tech", "communication"
  content: "Patient reports dizziness with current dose",
  authorId: "usr-rph-1",
  authorRole: "rph",
  createdAt: "2026-02-28T14:45:00.000",
}
```

**Append-only.** Notes are created, never updated or deleted. Use `createEntity` only.

---

## How Components Use These

### Rx Entry Panel
```javascript
const { getEntity, getEntities, updateEntity } = useData();
const rx = getEntity('prescription', prescriptionId);
const patient = getEntity('patient', rx.patientId);
const prescriber = rx.prescriberId ? getEntity('prescriber', rx.prescriberId) : null;
const drug = rx.drugId ? getEntity('drug', rx.drugId) : null;
```

### RPh Verify Panel
```javascript
const rx = getEntity('prescription', prescriptionId);
const patient = getEntity('patient', rx.patientId);
const prescriber = getEntity('prescriber', rx.prescriberId);
const drug = getEntity('drug', rx.drugId);
const patientRxs = getEntities('prescription', { patientId: rx.patientId });
const patientNotes = getEntities('note', { patientId: rx.patientId });
// RPh sees everything about this patient in one place
```

### Fill Panel
```javascript
const rx = getEntity('prescription', prescriptionId);
const drug = getEntity('drug', rx.drugId);
const invItem = getEntities('inventory', { ndc: rx.ndc })[0];
// Shows qty on hand, lot, expiry — updates live if another fill decrements it
```

### Queue Bar
```javascript
const allRxs = getEntities('prescription', {});
const pendingReview = allRxs.filter(rx => rx.status === 'pending_review');
// Each queue card:
const patient = getEntity('patient', rx.patientId);
// Patient name changes → queue card re-renders
// Rx status changes → card moves lanes
```

### Pickup Panel
```javascript
// Search returns patient, then:
const readyRxs = getEntities('prescription', { patientId, status: 'ready' });
// Display each with drug name, Rx number, etc.
```

---

## Loading Strategy

### On App Startup
```javascript
// Seed mock patients (until real DB is primary)
dispatch({ type: 'ENTITIES_LOADED', entityType: 'patient', data: MOCK_PATIENTS });

// Load all active prescriptions (not sold)
const rxs = await invoke('get_active_prescriptions');
dispatch({ type: 'ENTITIES_LOADED', entityType: 'prescription', data: rxs });

// Load all users
const users = await invoke('get_users');
dispatch({ type: 'ENTITIES_LOADED', entityType: 'user', data: users });
```

### On Workspace Open
```javascript
// Load this patient's full context
await loadEntities('prescription', { patientId });
await loadEntities('note', { patientId });
// Patient already in store from search/selection
```

### On Drug Search
```javascript
// User types in drug search, results come back from drug_tree.db
const results = await invoke('search_drugs', { query: searchText });
// Cache results in store so we don't re-fetch
dispatch({ type: 'ENTITIES_LOADED', entityType: 'drug', data: results });
```

### On Prescriber Lookup
```javascript
// When entering a prescriber on an Rx
const results = await invoke('search_prescribers', { query: searchText });
dispatch({ type: 'ENTITIES_LOADED', entityType: 'prescriber', data: results });
```

---

## Rust Backend Commands Needed

### Prescriptions (some exist in rx_engine.rs already)
```rust
#[tauri::command] fn get_active_prescriptions() -> Vec<Prescription>  // All non-sold
#[tauri::command] fn get_prescriptions_by_patient(patient_id: String) -> Vec<Prescription>
#[tauri::command] fn update_prescription(id: String, changes: String) -> Prescription
// create_prescription and transition_rx already exist
```

### Prescribers (new — needs table in pharmide.db or patients.db)
```rust
#[tauri::command] fn create_prescriber(data: String) -> Prescriber
#[tauri::command] fn update_prescriber(id: String, changes: String) -> Prescriber
#[tauri::command] fn search_prescribers(query: String) -> Vec<Prescriber>
#[tauri::command] fn get_prescriber(id: String) -> Prescriber
```

### Drugs (read-only from drug_tree.db — commands likely already exist)
```rust
// These probably exist already in drug_search.rs:
#[tauri::command] fn search_drugs(query: String) -> Vec<Drug>
#[tauri::command] fn get_drug(id: String) -> Drug
#[tauri::command] fn get_drug_by_ndc(ndc: String) -> Drug
```

### Inventory (some exist in inventory.rs)
```rust
#[tauri::command] fn get_inventory_by_ndc(ndc: String) -> InventoryItem
#[tauri::command] fn update_inventory(id: String, changes: String) -> InventoryItem
// adjust_on_hand likely already exists
```

### Notes (new)
```rust
#[tauri::command] fn create_note(data: String) -> Note
#[tauri::command] fn get_notes_by_patient(patient_id: String) -> Vec<Note>
#[tauri::command] fn get_notes_by_rx(rx_id: String) -> Vec<Note>
```

---

## Migration Strategy

Same as the patient migration — incremental:

1. **Add new entity types to initialStore** — just empty objects, nothing breaks
2. **Add prescription to the store** — seed from existing mock/DB data on startup
3. **Migrate QueueBar to read prescriptions from store** — highest impact proof
4. **Add prescriber to the store** — needed for Rx Entry flow
5. **Add drug cache to the store** — populate on search results
6. **Add inventory to the store** — needed for Fill panel
7. **Add notes to the store** — needed for Notes panel
8. **Migrate panels one at a time** — same approach as patient migration

Each step: add to store, migrate one component, test, move on.

---

## Rules

- Same rules as the patient data layer. Write-first. Backend is truth. Store is cache.
- Drugs are READ-ONLY in the store. They come from drug_tree.db and never get `updateEntity` calls.
- Notes are APPEND-ONLY. `createEntity` only, no updates.
- Prescriptions get `updateEntity` for data changes AND `transition_rx` for status changes. Both log to the event_log.
- Never copy entity data across entities. Always reference by ID and look up from store.
- Every component that currently receives entity data as a prop should eventually switch to `useData()`. Migrate incrementally, not all at once.
