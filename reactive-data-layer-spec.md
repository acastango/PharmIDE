# PharmIDE Reactive Data Layer — Implementation Spec

> Hand this to Claude Code alongside rx-engine-spec.md and CLAUDE.md.
> This spec defines the global data system that keeps every component in sync.

---

## Overview

Build a reactive data layer: one function that safely updates any entity in the system, persists the change to the Rust/SQLite backend, and propagates it to every UI component that references that entity. No stale data. No manual syncing. No component needs to know who else cares about the data it changed.

---

## Core Concept

**One update function. Three things happen every time:**

1. **Persist** — write the change to SQLite via Tauri command
2. **Update local state** — React state reflects the new data immediately
3. **Notify** — every subscribed component re-renders with the new data

```javascript
// Used anywhere in the app, same behavior every time
await updateEntity('patient', patientId, { lastName: 'Smith-Jones' });

// That single call:
// 1. Calls invoke('update_patient', { id: patientId, changes: { lastName: 'Smith-Jones' } })
// 2. Updates the patient in the global store
// 3. Every component displaying this patient's name re-renders
// 4. Logs the change to event_log
```

---

## Architecture

### Global Store (React Context)

A single store holding all active entities, keyed by type and ID.

```javascript
const store = {
  patients: {
    'patient-uuid-1': { id: 'patient-uuid-1', firstName: 'David', lastName: 'Chen', ... },
    'patient-uuid-2': { id: 'patient-uuid-2', firstName: 'Maria', lastName: 'Garcia', ... },
  },
  prescriptions: {
    'rx-uuid-1': { id: 'rx-uuid-1', patientId: 'patient-uuid-1', status: 'pending_review', ... },
    'rx-uuid-2': { id: 'rx-uuid-2', patientId: 'patient-uuid-1', status: 'in_fill', ... },
  },
  inventory: {
    'inv-uuid-1': { id: 'inv-uuid-1', ndc: '12345-678-90', qtyOnHand: 120, ... },
  },
  // Add more entity types as needed
};
```

**Key rule: Prescriptions reference `patientId`, not patient name.** Components that display a patient name on a prescription look it up from `store.patients[rx.patientId]`. Change the patient name once → it's correct everywhere because nothing copied it.

### Entity Types

| Type | Key fields | Referenced by |
|------|-----------|---------------|
| `patient` | id, firstName, lastName, dob, allergies, insurance, phone, address | prescriptions, notes, queue cards, workspace tabs |
| `prescription` | id, rx_number, patientId, status, scheduleClass, eorderData, techEntryData, rphReviewData, fillData | queue bar, workspace panels, event log |
| `inventory` | id, ndc, drugName, strength, form, qtyOnHand, lotNumber, expiry | fill panel, inventory panel |
| `user` | id, name, role, initials | event log actor, session display |
| `note` | id, patientId, rxId, content, noteType, authorId, timestamp | notes panel |

---

## The Update Function

### `updateEntity(entityType, entityId, changes, options)`

This is the single function used everywhere in the app to modify data.

```javascript
/**
 * Safely update any entity in the system.
 * Persists to backend, updates global state, notifies all subscribers.
 *
 * @param {string} entityType - 'patient', 'prescription', 'inventory', 'note', 'user'
 * @param {string} entityId - UUID of the entity
 * @param {object} changes - partial object of fields to update
 * @param {object} options - optional config
 * @param {string} options.actorId - who is making this change
 * @param {string} options.actorRole - 'tech', 'rph', 'system'
 * @param {string} options.reason - why (for audit log)
 * @param {boolean} options.silent - if true, skip event log (for UI-only state like panel focus)
 *
 * @returns {object} - the full updated entity
 * @throws {Error} - if backend rejects the change (validation failure, permission denied)
 */
async function updateEntity(entityType, entityId, changes, options = {}) {
  // 1. PERSIST — call the appropriate Tauri command
  const updated = await invoke(`update_${entityType}`, {
    id: entityId,
    changes: JSON.stringify(changes),
    actorId: options.actorId || currentUser.id,
    actorRole: options.actorRole || currentUser.role,
  });

  // 2. UPDATE LOCAL STATE — merge into global store
  dispatch({
    type: 'ENTITY_UPDATED',
    entityType,
    entityId,
    data: updated,
  });

  // 3. LOG — write to event log (unless silent)
  if (!options.silent) {
    await invoke('log_event', {
      eventType: `${entityType}:updated`,
      action: 'UPDATE',
      actorId: options.actorId || currentUser.id,
      actorRole: options.actorRole || currentUser.role,
      rxId: entityType === 'prescription' ? entityId : null,
      patientId: entityType === 'patient' ? entityId : updated.patientId || null,
      payload: JSON.stringify({
        changes,
        reason: options.reason || null,
      }),
    });
  }

  return updated;
}
```

### Companion Functions

```javascript
/**
 * Create a new entity. Same pattern: persist, add to store, log.
 */
async function createEntity(entityType, data, options = {}) {
  const created = await invoke(`create_${entityType}`, {
    data: JSON.stringify(data),
    actorId: options.actorId || currentUser.id,
    actorRole: options.actorRole || currentUser.role,
  });

  dispatch({
    type: 'ENTITY_CREATED',
    entityType,
    entityId: created.id,
    data: created,
  });

  if (!options.silent) {
    await invoke('log_event', {
      eventType: `${entityType}:created`,
      action: 'CREATE',
      actorId: options.actorId || currentUser.id,
      actorRole: options.actorRole || currentUser.role,
      rxId: entityType === 'prescription' ? created.id : null,
      patientId: entityType === 'patient' ? created.id : created.patientId || null,
      payload: JSON.stringify({ data }),
    });
  }

  return created;
}

/**
 * Load an entity (or set of entities) from backend into the store.
 * Used on app startup, when opening a workspace, or refreshing data.
 * Does NOT log — this is a read, not a mutation.
 */
async function loadEntities(entityType, query = {}) {
  const results = await invoke(`get_${entityType}s`, {
    query: JSON.stringify(query),
  });

  dispatch({
    type: 'ENTITIES_LOADED',
    entityType,
    data: results, // array of entities
  });

  return results;
}

/**
 * Get an entity from the local store (no backend call).
 * Use this in components for rendering — it's synchronous and fast.
 */
function getEntity(entityType, entityId) {
  return store[entityType + 's']?.[entityId] || null;
}

/**
 * Get all entities of a type matching a filter.
 * Example: getEntities('prescription', { patientId: 'uuid-1', status: 'pending_review' })
 */
function getEntities(entityType, filter = {}) {
  const collection = store[entityType + 's'] || {};
  const all = Object.values(collection);
  if (Object.keys(filter).length === 0) return all;

  return all.filter(entity =>
    Object.entries(filter).every(([key, value]) => entity[key] === value)
  );
}
```

---

## Store Reducer

```javascript
function storeReducer(state, action) {
  switch (action.type) {
    case 'ENTITY_CREATED':
    case 'ENTITY_UPDATED': {
      const collection = action.entityType + 's';
      return {
        ...state,
        [collection]: {
          ...state[collection],
          [action.entityId]: action.data,
        },
      };
    }

    case 'ENTITIES_LOADED': {
      const collection = action.entityType + 's';
      const newEntities = {};
      for (const entity of action.data) {
        newEntities[entity.id] = entity;
      }
      return {
        ...state,
        [collection]: {
          ...state[collection],
          ...newEntities,
        },
      };
    }

    case 'ENTITY_DELETED': {
      const collection = action.entityType + 's';
      const { [action.entityId]: _, ...remaining } = state[collection];
      return {
        ...state,
        [collection]: remaining,
      };
    }

    default:
      return state;
  }
}
```

---

## React Integration

### Provider

```javascript
// Wrap the entire app
function DataProvider({ children }) {
  const [store, dispatch] = useReducer(storeReducer, {
    patients: {},
    prescriptions: {},
    inventory: {},
    notes: {},
    users: {},
  });

  // Make the store and functions available everywhere
  const value = {
    store,
    dispatch,
    updateEntity,
    createEntity,
    loadEntities,
    getEntity: (type, id) => store[type + 's']?.[id] || null,
    getEntities: (type, filter) => {
      const all = Object.values(store[type + 's'] || {});
      if (!filter || Object.keys(filter).length === 0) return all;
      return all.filter(e => Object.entries(filter).every(([k, v]) => e[k] === v));
    },
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

// Hook for components
function useData() {
  return useContext(DataContext);
}
```

### Usage in Components

```javascript
// Queue bar — shows all prescriptions grouped by status
function QueueBar() {
  const { getEntities } = useData();
  const pendingReview = getEntities('prescription', { status: 'pending_review' });
  const inFill = getEntities('prescription', { status: 'in_fill' });
  // ... renders queue lanes
  // Automatically re-renders when ANY prescription's status changes
}

// Workspace tab — shows patient name
function WorkspaceTab({ patientId }) {
  const { getEntity } = useData();
  const patient = getEntity('patient', patientId);
  return <div>{patient.firstName} {patient.lastName}</div>;
  // Automatically re-renders when patient name changes
}

// Rx Entry panel — tech submits, updates prescription
function RxEntryPanel({ prescriptionId }) {
  const { getEntity, updateEntity } = useData();
  const rx = getEntity('prescription', prescriptionId);

  async function handleSubmit(formData) {
    await updateEntity('prescription', prescriptionId, {
      techEntryData: formData,
    }, {
      reason: 'Tech completed data entry',
    });

    // Then trigger state machine transition (from rx-engine-spec)
    await invoke('transition_rx', {
      rxId: prescriptionId,
      action: 'SUBMIT_RX',
      actorId: currentUser.id,
      actorRole: 'tech',
      payload: JSON.stringify(formData),
    });
  }
}

// Patient profile — change patient name, entire system updates
function PatientProfile({ patientId }) {
  const { getEntity, updateEntity } = useData();
  const patient = getEntity('patient', patientId);

  async function handleNameChange(newLastName) {
    await updateEntity('patient', patientId, {
      lastName: newLastName,
    }, {
      reason: 'Patient name correction',
    });
    // That's it. Every component showing this patient's name
    // already re-renders because they read from the same store.
  }
}
```

---

## How This Connects to the Rx Engine

The Rx engine (rx-engine-spec.md) handles state transitions. The data layer handles everything else. They work together:

```javascript
// Full flow: tech submits a prescription for review

// 1. Save the tech's entry data via data layer
await updateEntity('prescription', rxId, {
  techEntryData: formData,
}, { reason: 'Tech entry complete' });

// 2. Transition state via Rx engine
const result = await invoke('transition_rx', {
  rxId,
  action: 'SUBMIT_RX',
  actorId: currentUser.id,
  actorRole: 'tech',
  payload: JSON.stringify(formData),
});

// 3. Update local state with new status from engine result
dispatch({
  type: 'ENTITY_UPDATED',
  entityType: 'prescription',
  entityId: rxId,
  data: { ...getEntity('prescription', rxId), status: result.new_status },
});

// Result: prescription data saved, status transitioned, event logged,
// queue bar moved the card, RPh review panel populated, workspace badge updated.
// All from one user action.
```

**Important:** The `transition_rx` Rust command already logs to the event_log (see rx-engine-spec). The `updateEntity` call also logs. These are two different log entries — one for "data changed" and one for "state transitioned." Both matter for the audit trail.

---

## Rust Backend Commands Needed

Each entity type needs these Tauri commands:

```rust
// Patient
#[tauri::command] fn create_patient(data: String, actor_id: String, actor_role: String) -> Patient
#[tauri::command] fn update_patient(id: String, changes: String, actor_id: String, actor_role: String) -> Patient
#[tauri::command] fn get_patient(id: String) -> Patient
#[tauri::command] fn get_patients(query: String) -> Vec<Patient>

// Prescription (some already defined in rx-engine-spec)
#[tauri::command] fn update_prescription(id: String, changes: String, actor_id: String, actor_role: String) -> Prescription
// create_prescription, get_prescription, get_prescriptions_by_patient, get_prescriptions_by_status
// already in rx-engine-spec

// Inventory
#[tauri::command] fn create_inventory_item(data: String, actor_id: String, actor_role: String) -> InventoryItem
#[tauri::command] fn update_inventory_item(id: String, changes: String, actor_id: String, actor_role: String) -> InventoryItem
#[tauri::command] fn get_inventory_item(id: String) -> InventoryItem
#[tauri::command] fn get_inventory_items(query: String) -> Vec<InventoryItem>

// Note
#[tauri::command] fn create_note(data: String, actor_id: String, actor_role: String) -> Note
#[tauri::command] fn get_notes(query: String) -> Vec<Note>
// Notes are append-only, no update_note needed

// User
#[tauri::command] fn create_user(data: String) -> User
#[tauri::command] fn update_user(id: String, changes: String) -> User
#[tauri::command] fn get_user(id: String) -> User
#[tauri::command] fn get_users() -> Vec<User>
```

### Rust-Side Validation

The Rust `update_*` commands should validate before persisting:

- **Type checking** — ensure fields match expected types
- **Required fields** — don't allow nullifying required fields
- **Permission checks** — some fields may be role-restricted (e.g., only RPh can modify rphReviewData)
- **Referential integrity** — patientId on a prescription must reference an existing patient

If validation fails, return an error. The frontend `updateEntity` function throws, the UI can display the error, and the store is NOT updated (because persist failed before local state update).

---

## Data Loading Strategy

### On App Startup
```javascript
// Load the current user
await loadEntities('user', { id: sessionUserId });

// Load active prescriptions (not yet picked up)
await loadEntities('prescription', { statusNot: 'ready' });

// Don't load all patients — load on demand when workspace opens
```

### On Workspace Open
```javascript
// When tech opens a patient workspace, load that patient's data
await loadEntities('patient', { id: patientId });
await loadEntities('prescription', { patientId });
await loadEntities('note', { patientId });
```

### On Workspace Close
```javascript
// Optionally evict patient data from store to save memory
// (Only if no other workspace references this patient)
dispatch({ type: 'ENTITY_DELETED', entityType: 'patient', entityId: patientId });
```

---

## Important Constraints

- **Backend is ALWAYS the source of truth.** The React store is a cache. If there's ever a conflict, re-fetch from backend.
- **Never copy entity data into another entity.** Prescriptions store `patientId`, not patient name. Components look up the patient from the store. This is why one name change propagates everywhere.
- **Every mutation goes through `updateEntity` or `createEntity`.** No direct `dispatch` calls for data changes from components. The functions enforce persist-first, then update local state.
- **Notes are append-only.** Like the event log. `createEntity('note', ...)` only. No `updateEntity` for notes.
- **Event log writes happen in both layers.** Data changes log via `updateEntity`. State transitions log via `transition_rx`. Both feed the same Merkle-chained event_log table. Both are auditable.
- **Silent mode exists for UI-only state.** Panel focus, workspace arrangement, scroll position — things that don't need audit trails. Use `{ silent: true }` to skip logging.

---

## Build Order

1. Store reducer + DataProvider context
2. `updateEntity` and `createEntity` functions (with Tauri invoke stubs initially)
3. `loadEntities` and `getEntity` / `getEntities` helpers
4. Wire up existing components to use `useData()` instead of local state
5. Build Rust backend commands for each entity type
6. Connect real Tauri invocations to the functions
7. Test: change a patient name in one panel, verify it updates everywhere
