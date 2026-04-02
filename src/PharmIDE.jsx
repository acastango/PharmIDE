import { useState, useCallback, useRef, useEffect, createContext, useContext, useMemo, useReducer } from "react";
import { createTauriDataProvider } from './TauriDataProvider';
import InventoryWorkspace from './InventoryWorkspace';

// ============================================================
// DARK THEME
// ============================================================
const T = {
  // Surfaces
  bg: "#13151a",           // app background
  surface: "#1a1d24",      // panels, cards
  surfaceRaised: "#21242d", // elevated surfaces (tile content)
  surfaceBorder: "rgba(255,255,255,0.07)", // borders between surfaces
  surfaceHover: "#262a35",  // hover states

  // Tile chrome
  tileBg: "#1e2129",       // tile background
  tileBorder: "rgba(255,255,255,0.06)",   // tile border
  tileHeaderBg: "#1a1d24", // tile title bar (tinted by workspace color)

  // Text
  textPrimary: "#e2e8f0",  // main text
  textSecondary: "#8b95a8", // secondary / labels
  textMuted: "#5a6475",     // disabled / placeholder
  textAccent: "#94a3b8",    // subtle emphasis

  // Input fields
  inputBg: "#1a1d24",
  inputBorder: "rgba(255,255,255,0.09)",
  inputFocusBorder: "rgba(255,255,255,0.22)",
  inputText: "#e2e8f0",

  // Queue bar
  queueBg: "#111318",
  queueBorder: "#1e2129",

  // Shared
  radius: 16,              // default border radius
  radiusSm: 10,            // smaller elements
  radiusXs: 8,             // buttons, inputs

  // Font
  sans: "'Outfit', -apple-system, sans-serif",
  mono: "'Outfit', -apple-system, sans-serif",
  sizeBase: 13,
  sizeSm: 11,
  sizeXs: 10,
};
// DATA PROVIDER INTERFACE
// ============================================================
// This is the contract. Everything that supplies data to PharmIDE
// implements this interface. Right now it's mock-backed.
// Swap in PharmSim API, REST, local DB — the form doesn't care.

const DataProviderContext = createContext(null);

function useDataProvider() {
  const ctx = useContext(DataProviderContext);
  if (!ctx) throw new Error("useDataProvider must be used within DataProviderContext");
  return ctx;
}

// ============================================================
// ENTITY STORE — reactive data layer
// ============================================================
const DataContext = createContext(null);

function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used within DataProvider");
  return ctx;
}

function storeReducer(state, action) {
  switch (action.type) {
    case 'ENTITY_CREATED':
    case 'ENTITY_UPDATED': {
      const col = action.entityType + 's';
      return { ...state, [col]: { ...state[col], [action.entityId]: action.data } };
    }
    case 'ENTITIES_LOADED': {
      const col = action.entityType + 's';
      const incoming = {};
      for (const e of action.data) incoming[e.id] = e;
      return { ...state, [col]: { ...state[col], ...incoming } };
    }
    case 'ENTITY_DELETED': {
      const col = action.entityType + 's';
      const { [action.entityId]: _, ...rest } = state[col];
      return { ...state, [col]: rest };
    }
    case 'SET_PRESCRIBERS':
      return { ...state, prescribers: action.prescribers };
    default: return state;
  }
}

// Convert a raw DB prescription (JSON string fields) to a parsed store object.
function normalizeRxFromDb(rx) {
  const parse = (v) => {
    if (!v) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  };
  return {
    id: rx.id,
    rxNumber: rx.rxNumber || rx.rx_number || null,
    patientId: rx.patientId || rx.patient_id,
    status: rx.status,
    scheduleClass: rx.scheduleClass || rx.schedule_class || null,
    createdAt: rx.createdAt || rx.created_at,
    updatedAt: rx.updatedAt || rx.updated_at,
    techEntryData: parse(rx.techEntryData || rx.tech_entry_data),
    rphReviewData: parse(rx.rphReviewData || rx.rph_review_data),
    fillData: parse(rx.fillData || rx.fill_data),
    rphFillReviewData: parse(rx.rphFillReviewData || rx.rph_fill_review_data),
    eOrder: parse(rx.eorderData || rx.eorder_data),
  };
}

// Fetch the latest prescription from the backend and push it into the reactive
// store. Call after any state-machine transition so that RxHistoryContent,
// QueueBar, and any other store consumer always sees current data.
// Safe to call with a null/undefined id — it no-ops in that case.
async function syncRxToStore(prescriptionId, data, storeDispatch) {
  if (!prescriptionId) return;
  try {
    const updated = await data.getPrescription(prescriptionId);
    if (updated) {
      storeDispatch({
        type: 'ENTITY_UPDATED',
        entityType: 'prescription',
        entityId: updated.id,
        data: normalizeRxFromDb(updated),
      });
    }
  } catch (_) { /* non-fatal */ }
}

function DataProvider({ backendProvider, children }) {
  const [store, storeDispatch] = useReducer(storeReducer, {
    patients: {},
    prescriptions: {},
    prescribers: {},
    drugs: {},
    inventory: {},
    notes: {},
    users: {},
  });

  // Seed patients from MOCK_PATIENTS on mount
  useEffect(() => {
    storeDispatch({ type: 'ENTITIES_LOADED', entityType: 'patient', data: MOCK_PATIENTS });
  }, []);

  // Seed prescribers from PRESCRIBER_DATABASE, then merge DB records
  useEffect(() => {
    const byId = {};
    PRESCRIBER_DATABASE.forEach(p => { byId[p.id] = p; });
    storeDispatch({ type: 'SET_PRESCRIBERS', prescribers: byId });
    backendProvider.getAllPrescribers?.().then(list => {
      if (!list?.length) return;
      const merged = { ...byId };
      list.forEach(p => { merged[p.id] = p; });
      storeDispatch({ type: 'SET_PRESCRIBERS', prescribers: merged });
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // updateEntity: merge changes locally, persist via backend, update store
  const updateEntity = useCallback(async (entityType, entityId, changes, options = {}) => {
    const col = entityType + 's';
    const current = store[col]?.[entityId] || {};
    const merged = { ...current, ...changes };

    let persisted = merged;
    if (entityType === 'patient') {
      try {
        const saved = await backendProvider.upsertPatient(serializePatientRow(merged));
        if (saved) persisted = parsePatientRow(saved);
      } catch (_) { /* backend unavailable — use merged */ }
    } else if (entityType === 'prescriber') {
      try {
        const saved = await backendProvider.upsertPrescriber(merged);
        if (saved) persisted = saved;
      } catch (_) { /* backend unavailable — use merged */ }
    }

    storeDispatch({ type: 'ENTITY_UPDATED', entityType, entityId, data: persisted });
    return persisted;
  }, [store, backendProvider]);

  const getEntity = useCallback((type, id) => store[type + 's']?.[id] || null, [store]);

  const getEntities = useCallback((type, filter = {}) => {
    const all = Object.values(store[type + 's'] || {});
    if (!Object.keys(filter).length) return all;
    return all.filter(e => Object.entries(filter).every(([k, v]) => e[k] === v));
  }, [store]);

  const searchPrescribers = useCallback((query) => {
    if (!query || query.trim().length < 2) return [];
    const q = query.toLowerCase();
    return Object.values(store.prescribers).filter(p =>
      `${p.firstName} ${p.lastName}`.toLowerCase().includes(q) ||
      p.lastName?.toLowerCase().includes(q) ||
      p.formerLastName?.toLowerCase().includes(q) ||
      p.dea?.toLowerCase().includes(q) ||
      p.npi?.toLowerCase().includes(q) ||
      p.practice?.toLowerCase().includes(q)
    ).map(p => {
      const last = (p.lastName || '').toLowerCase();
      const full = `${p.firstName} ${p.lastName}`.toLowerCase();
      let score = 50;
      if (last === q) score = 0;
      else if (last.startsWith(q)) score = 10;
      else if (full.startsWith(q)) score = 15;
      else if (p.dea?.toLowerCase().startsWith(q) || p.npi?.startsWith(q)) score = 20;
      else if (last.includes(q)) score = 30;
      return { ...p, _score: score };
    }).sort((a, b) => a._score - b._score || a.lastName.localeCompare(b.lastName)).slice(0, 10);
  }, [store.prescribers]);

  const getPrescriberById = useCallback((id) => store.prescribers[id] || null, [store.prescribers]);

  const value = useMemo(() => ({
    store, storeDispatch, updateEntity, getEntity, getEntities,
    searchPrescribers, getPrescriberById,
  }), [store, updateEntity, getEntity, getEntities, searchPrescribers, getPrescriberById]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

// Loads active prescriptions after login — seeds both UI reducer and entity store.
// Must render inside DataProvider (needs useData) and PharmIDEContext (needs dispatch).
function AppStartup() {
  const { dispatch, currentUser } = useContext(PharmIDEContext);
  const data = useDataProvider();
  const { storeDispatch } = useData();

  useEffect(() => {
    if (!currentUser) return;
    data.getActivePrescriptions().then(prescriptions => {
      if (!prescriptions?.length) return;
      prescriptions.forEach(rx => {
        dispatch({ type: "RESTORE_PRESCRIPTION", prescription: rx });
      });
      storeDispatch({
        type: 'ENTITIES_LOADED',
        entityType: 'prescription',
        data: prescriptions.map(normalizeRxFromDb),
      });
    });
    // Refresh prescriber records from DB after login (picks up any changes
    // made in other sessions while app was closed).
    data.getAllPrescribers?.().then(list => {
      if (!list?.length) return;
      const byId = {};
      list.forEach(p => { byId[p.id] = p; });
      storeDispatch({ type: 'SET_PRESCRIBERS', prescribers: byId });
    }).catch(() => {});
  }, [currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ── Mock Drug Database ──────────────────────────────────────
const DRUG_DATABASE = [
  {
    id: "d001", name: "lisinopril", brandNames: ["Zestril", "Prinivil"],
    strengths: ["2.5mg", "5mg", "10mg", "20mg", "40mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "ACE Inhibitor",
    maxDaily: "80mg", commonDoses: ["10mg daily", "20mg daily"],
    ndcByStrength: { "2.5mg": "68180-0513-01", "5mg": "68180-0514-01", "10mg": "68180-0515-01", "20mg": "68180-0516-01", "40mg": "68180-0517-01" },
  },
  {
    id: "d002", name: "metformin", brandNames: ["Glucophage"],
    strengths: ["500mg", "850mg", "1000mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Biguanide",
    maxDaily: "2550mg", commonDoses: ["500mg BID", "1000mg BID"],
    ndcByStrength: { "500mg": "00228-2775-11", "850mg": "00228-2776-11", "1000mg": "00228-2791-11" },
  },
  {
    id: "d003", name: "atorvastatin", brandNames: ["Lipitor"],
    strengths: ["10mg", "20mg", "40mg", "80mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "HMG-CoA Reductase Inhibitor",
    maxDaily: "80mg", commonDoses: ["20mg daily", "40mg daily"],
    ndcByStrength: { "10mg": "00071-0155-23", "20mg": "00071-0156-23", "40mg": "00071-0157-23", "80mg": "00071-0158-23" },
  },
  {
    id: "d004", name: "amlodipine", brandNames: ["Norvasc"],
    strengths: ["2.5mg", "5mg", "10mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Calcium Channel Blocker",
    maxDaily: "10mg", commonDoses: ["5mg daily", "10mg daily"],
    ndcByStrength: { "2.5mg": "00069-1520-30", "5mg": "00069-1530-30", "10mg": "00069-1540-30" },
  },
  {
    id: "d005", name: "escitalopram", brandNames: ["Lexapro"],
    strengths: ["5mg", "10mg", "20mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "SSRI",
    maxDaily: "20mg", commonDoses: ["10mg daily", "20mg daily"],
    ndcByStrength: { "5mg": "00456-2005-01", "10mg": "00456-2010-01", "20mg": "00456-2020-01" },
  },
  {
    id: "d006", name: "omeprazole", brandNames: ["Prilosec"],
    strengths: ["10mg", "20mg", "40mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "Proton Pump Inhibitor",
    maxDaily: "40mg", commonDoses: ["20mg daily", "40mg BID"],
    ndcByStrength: { "10mg": "00186-5010-31", "20mg": "00186-5020-31", "40mg": "00186-5040-31" },
  },
  {
    id: "d007", name: "gabapentin", brandNames: ["Neurontin"],
    strengths: ["100mg", "300mg", "400mg", "600mg", "800mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "Anticonvulsant",
    maxDaily: "3600mg", commonDoses: ["300mg TID", "600mg TID"],
    ndcByStrength: { "100mg": "00071-0803-24", "300mg": "00071-0805-24", "400mg": "00071-0806-24", "600mg": "00071-0807-24", "800mg": "00071-0808-24" },
  },
  {
    id: "d008", name: "metoprolol succinate", brandNames: ["Toprol-XL"],
    strengths: ["25mg", "50mg", "100mg", "200mg"], form: "tablet, extended release",
    route: "oral", schedule: "Rx", drugClass: "Beta Blocker",
    maxDaily: "400mg", commonDoses: ["25mg daily", "50mg daily"],
    ndcByStrength: { "25mg": "00186-1088-05", "50mg": "00186-1092-05", "100mg": "00186-1096-05", "200mg": "00186-1097-05" },
  },
  {
    id: "d009", name: "levothyroxine", brandNames: ["Synthroid", "Levoxyl"],
    strengths: ["25mcg", "50mcg", "75mcg", "88mcg", "100mcg", "112mcg", "125mcg", "150mcg", "200mcg"],
    form: "tablet", route: "oral", schedule: "Rx", drugClass: "Thyroid Hormone",
    maxDaily: "300mcg", commonDoses: ["50mcg daily", "100mcg daily"],
    ndcByStrength: { "25mcg": "00074-6624-90", "50mcg": "00074-6625-90", "75mcg": "00074-6627-90", "88mcg": "00074-6628-90", "100mcg": "00074-6629-90", "112mcg": "00074-6630-90", "125mcg": "00074-6631-90", "150mcg": "00074-6633-90", "200mcg": "00074-6636-90" },
  },
  {
    id: "d010", name: "montelukast", brandNames: ["Singulair"],
    strengths: ["4mg", "5mg", "10mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Leukotriene Receptor Antagonist",
    maxDaily: "10mg", commonDoses: ["10mg daily at bedtime"],
    ndcByStrength: { "4mg": "00006-0711-31", "5mg": "00006-0275-31", "10mg": "00006-0117-31" },
  },
  {
    id: "d011", name: "oxycodone", brandNames: ["OxyContin", "Roxicodone"],
    strengths: ["5mg", "10mg", "15mg", "20mg", "30mg"], form: "tablet",
    route: "oral", schedule: "C-II", drugClass: "Opioid Analgesic",
    maxDaily: null, commonDoses: ["5mg q4-6h PRN"],
    ndcByStrength: { "5mg": "59011-0410-10", "10mg": "59011-0420-10", "15mg": "59011-0430-10", "20mg": "59011-0440-10", "30mg": "59011-0450-10" },
  },
  {
    id: "d012", name: "alprazolam", brandNames: ["Xanax"],
    strengths: ["0.25mg", "0.5mg", "1mg", "2mg"], form: "tablet",
    route: "oral", schedule: "C-IV", drugClass: "Benzodiazepine",
    maxDaily: "4mg", commonDoses: ["0.25mg TID PRN", "0.5mg TID PRN"],
    ndcByStrength: { "0.25mg": "00009-0029-01", "0.5mg": "00009-0055-01", "1mg": "00009-0090-01", "2mg": "00009-0094-01" },
  },
  {
    id: "d013", name: "hydrocodone/acetaminophen", brandNames: ["Norco", "Vicodin"],
    strengths: ["5/325mg", "7.5/325mg", "10/325mg"], form: "tablet",
    route: "oral", schedule: "C-II", drugClass: "Opioid Analgesic Combination",
    maxDaily: "6 tablets (10/325)", commonDoses: ["1 tab q4-6h PRN"],
    ndcByStrength: { "5/325mg": "52544-0161-01", "7.5/325mg": "52544-0162-01", "10/325mg": "52544-0163-01" },
  },
  {
    id: "d014", name: "tramadol", brandNames: ["Ultram"],
    strengths: ["50mg", "100mg"], form: "tablet",
    route: "oral", schedule: "C-IV", drugClass: "Opioid Analgesic",
    maxDaily: "400mg", commonDoses: ["50mg q4-6h PRN"],
    ndcByStrength: { "50mg": "00045-0659-60", "100mg": "00045-0660-60" },
  },
  {
    id: "d015", name: "amoxicillin", brandNames: ["Amoxil"],
    strengths: ["250mg", "500mg", "875mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "Penicillin Antibiotic",
    maxDaily: "3000mg", commonDoses: ["500mg TID", "875mg BID"],
    ndcByStrength: { "250mg": "65862-0001-01", "500mg": "65862-0002-01", "875mg": "65862-0003-01" },
  },
  {
    id: "d016", name: "azithromycin", brandNames: ["Zithromax", "Z-Pack"],
    strengths: ["250mg", "500mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Macrolide Antibiotic",
    maxDaily: "500mg", commonDoses: ["500mg day 1, then 250mg x4 days"],
    ndcByStrength: { "250mg": "00069-3060-75", "500mg": "00069-3070-30" },
  },
  {
    id: "d017", name: "prednisone", brandNames: ["Deltasone"],
    strengths: ["1mg", "2.5mg", "5mg", "10mg", "20mg", "50mg"], form: "tablet",
    route: "oral", schedule: "Rx", drugClass: "Corticosteroid",
    maxDaily: null, commonDoses: ["10mg daily", "20mg taper"],
    ndcByStrength: { "1mg": "00054-4741-25", "2.5mg": "00054-4742-25", "5mg": "00054-4728-25", "10mg": "00054-4729-25", "20mg": "00054-4730-25", "50mg": "00054-4731-25" },
  },
  {
    id: "d018", name: "fluoxetine", brandNames: ["Prozac"],
    strengths: ["10mg", "20mg", "40mg", "60mg"], form: "capsule",
    route: "oral", schedule: "Rx", drugClass: "SSRI",
    maxDaily: "80mg", commonDoses: ["20mg daily", "40mg daily"],
    ndcByStrength: { "10mg": "00777-3105-02", "20mg": "00777-3106-02", "40mg": "00777-3107-02", "60mg": "00777-3108-02" },
  },
];

// ── Mock Product Database (specific dispensable products) ────
// Each product links to a drug concept and represents a specific
// manufacturer + strength + form + pack size with its own NDC.
const PRODUCT_DATABASE = [
  // ── Lisinopril products ──
  { id: "pr001", drugId: "d001", ndc: "68180-0514-01", strength: "5mg", form: "tablet", manufacturer: "Lupin", packSize: 100, packUnit: "EA", description: "Lisinopril 5mg Tab (Lupin) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr002", drugId: "d001", ndc: "68180-0515-01", strength: "10mg", form: "tablet", manufacturer: "Lupin", packSize: 100, packUnit: "EA", description: "Lisinopril 10mg Tab (Lupin) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr003", drugId: "d001", ndc: "68180-0516-01", strength: "20mg", form: "tablet", manufacturer: "Lupin", packSize: 100, packUnit: "EA", description: "Lisinopril 20mg Tab (Lupin) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr004", drugId: "d001", ndc: "00071-0207-23", strength: "10mg", form: "tablet", manufacturer: "Merck (Prinivil)", packSize: 90, packUnit: "EA", description: "Prinivil 10mg Tab (Merck) 90ct", isGeneric: false, abRating: "AB" },

  // ── Metformin products ──
  { id: "pr010", drugId: "d002", ndc: "00228-2775-11", strength: "500mg", form: "tablet", manufacturer: "Actavis", packSize: 100, packUnit: "EA", description: "Metformin HCl 500mg Tab (Actavis) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr011", drugId: "d002", ndc: "00228-2791-11", strength: "1000mg", form: "tablet", manufacturer: "Actavis", packSize: 100, packUnit: "EA", description: "Metformin HCl 1000mg Tab (Actavis) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr012", drugId: "d002", ndc: "00087-6060-05", strength: "500mg", form: "tablet", manufacturer: "Novartis (Glucophage)", packSize: 100, packUnit: "EA", description: "Glucophage 500mg Tab (Novartis) 100ct", isGeneric: false, abRating: "AB" },

  // ── Atorvastatin products ──
  { id: "pr020", drugId: "d003", ndc: "00591-3775-01", strength: "10mg", form: "tablet", manufacturer: "Watson", packSize: 90, packUnit: "EA", description: "Atorvastatin 10mg Tab (Watson) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr021", drugId: "d003", ndc: "00591-3776-01", strength: "20mg", form: "tablet", manufacturer: "Watson", packSize: 90, packUnit: "EA", description: "Atorvastatin 20mg Tab (Watson) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr022", drugId: "d003", ndc: "00591-3777-01", strength: "40mg", form: "tablet", manufacturer: "Watson", packSize: 90, packUnit: "EA", description: "Atorvastatin 40mg Tab (Watson) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr023", drugId: "d003", ndc: "00071-0157-23", strength: "40mg", form: "tablet", manufacturer: "Pfizer (Lipitor)", packSize: 90, packUnit: "EA", description: "Lipitor 40mg Tab (Pfizer) 90ct", isGeneric: false, abRating: "AB" },

  // ── Amlodipine products ──
  { id: "pr030", drugId: "d004", ndc: "00069-1530-30", strength: "5mg", form: "tablet", manufacturer: "Pfizer (Norvasc)", packSize: 30, packUnit: "EA", description: "Norvasc 5mg Tab (Pfizer) 30ct", isGeneric: false, abRating: "AB" },
  { id: "pr031", drugId: "d004", ndc: "31722-0702-01", strength: "5mg", form: "tablet", manufacturer: "Camber", packSize: 100, packUnit: "EA", description: "Amlodipine 5mg Tab (Camber) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr032", drugId: "d004", ndc: "31722-0703-01", strength: "10mg", form: "tablet", manufacturer: "Camber", packSize: 100, packUnit: "EA", description: "Amlodipine 10mg Tab (Camber) 100ct", isGeneric: true, abRating: "AB" },

  // ── Escitalopram products ──
  { id: "pr040", drugId: "d005", ndc: "00093-5851-01", strength: "10mg", form: "tablet", manufacturer: "Teva", packSize: 100, packUnit: "EA", description: "Escitalopram 10mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr041", drugId: "d005", ndc: "00093-5852-01", strength: "20mg", form: "tablet", manufacturer: "Teva", packSize: 100, packUnit: "EA", description: "Escitalopram 20mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr042", drugId: "d005", ndc: "00456-2010-30", strength: "10mg", form: "tablet", manufacturer: "Forest (Lexapro)", packSize: 30, packUnit: "EA", description: "Lexapro 10mg Tab (Forest) 30ct", isGeneric: false, abRating: "AB" },
  { id: "pr043", drugId: "d005", ndc: "51991-0747-01", strength: "10mg", form: "tablet", manufacturer: "Cipla", packSize: 100, packUnit: "EA", description: "Escitalopram 10mg Tab (Cipla) 100ct", isGeneric: true, abRating: "AB" },

  // ── Omeprazole products ──
  { id: "pr050", drugId: "d006", ndc: "62175-0450-37", strength: "20mg", form: "capsule", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Omeprazole DR 20mg Cap (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr051", drugId: "d006", ndc: "00186-5020-31", strength: "20mg", form: "capsule", manufacturer: "AstraZeneca (Prilosec)", packSize: 30, packUnit: "EA", description: "Prilosec 20mg Cap (AstraZeneca) 30ct", isGeneric: false, abRating: "AB" },

  // ── Gabapentin products ──
  { id: "pr060", drugId: "d007", ndc: "27241-0049-03", strength: "300mg", form: "capsule", manufacturer: "Ascend", packSize: 500, packUnit: "EA", description: "Gabapentin 300mg Cap (Ascend) 500ct", isGeneric: true, abRating: "AB" },
  { id: "pr061", drugId: "d007", ndc: "27241-0050-03", strength: "400mg", form: "capsule", manufacturer: "Ascend", packSize: 500, packUnit: "EA", description: "Gabapentin 400mg Cap (Ascend) 500ct", isGeneric: true, abRating: "AB" },
  { id: "pr062", drugId: "d007", ndc: "00071-0805-24", strength: "300mg", form: "capsule", manufacturer: "Pfizer (Neurontin)", packSize: 100, packUnit: "EA", description: "Neurontin 300mg Cap (Pfizer) 100ct", isGeneric: false, abRating: "AB" },

  // ── Metoprolol Succinate products ──
  { id: "pr070", drugId: "d008", ndc: "00378-1025-01", strength: "25mg", form: "tablet, extended release", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Metoprolol Succ ER 25mg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr071", drugId: "d008", ndc: "00378-1050-01", strength: "50mg", form: "tablet, extended release", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Metoprolol Succ ER 50mg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr072", drugId: "d008", ndc: "00186-1088-05", strength: "25mg", form: "tablet, extended release", manufacturer: "AstraZeneca (Toprol-XL)", packSize: 100, packUnit: "EA", description: "Toprol-XL 25mg Tab (AstraZeneca) 100ct", isGeneric: false, abRating: "AB" },

  // ── Oxycodone products (C-II) ──
  { id: "pr080", drugId: "d011", ndc: "59011-0410-10", strength: "5mg", form: "tablet", manufacturer: "Mallinckrodt", packSize: 100, packUnit: "EA", description: "Oxycodone HCl 5mg Tab (Mallinckrodt) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr081", drugId: "d011", ndc: "59011-0420-10", strength: "10mg", form: "tablet", manufacturer: "Mallinckrodt", packSize: 100, packUnit: "EA", description: "Oxycodone HCl 10mg Tab (Mallinckrodt) 100ct", isGeneric: true, abRating: "AB" },

  // ── Hydrocodone/APAP products (C-II) ──
  { id: "pr085", drugId: "d013", ndc: "52544-0161-01", strength: "5/325mg", form: "tablet", manufacturer: "Watson (Norco)", packSize: 100, packUnit: "EA", description: "Hydrocodone/APAP 5/325mg Tab (Watson) 100ct", isGeneric: false, abRating: "AB" },
  { id: "pr086", drugId: "d013", ndc: "00406-0123-01", strength: "10/325mg", form: "tablet", manufacturer: "Mallinckrodt", packSize: 100, packUnit: "EA", description: "Hydrocodone/APAP 10/325mg Tab (Mallinckrodt) 100ct", isGeneric: true, abRating: "AB" },

  // ── Alprazolam products (C-IV) ──
  { id: "pr090", drugId: "d012", ndc: "00555-0264-02", strength: "0.5mg", form: "tablet", manufacturer: "Barr/Teva", packSize: 100, packUnit: "EA", description: "Alprazolam 0.5mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr091", drugId: "d012", ndc: "00009-0055-01", strength: "0.5mg", form: "tablet", manufacturer: "Pfizer (Xanax)", packSize: 100, packUnit: "EA", description: "Xanax 0.5mg Tab (Pfizer) 100ct", isGeneric: false, abRating: "AB" },
  { id: "pr092", drugId: "d012", ndc: "00555-0269-02", strength: "1mg", form: "tablet", manufacturer: "Barr/Teva", packSize: 100, packUnit: "EA", description: "Alprazolam 1mg Tab (Teva) 100ct", isGeneric: true, abRating: "AB" },

  // ── Amoxicillin products ──
  { id: "pr100", drugId: "d015", ndc: "65862-0002-01", strength: "500mg", form: "capsule", manufacturer: "Aurobindo", packSize: 100, packUnit: "EA", description: "Amoxicillin 500mg Cap (Aurobindo) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr101", drugId: "d015", ndc: "65862-0003-01", strength: "875mg", form: "tablet", manufacturer: "Aurobindo", packSize: 20, packUnit: "EA", description: "Amoxicillin 875mg Tab (Aurobindo) 20ct", isGeneric: true, abRating: "AB" },

  // ── Montelukast products ──
  { id: "pr110", drugId: "d010", ndc: "00093-7612-56", strength: "10mg", form: "tablet", manufacturer: "Teva", packSize: 90, packUnit: "EA", description: "Montelukast 10mg Tab (Teva) 90ct", isGeneric: true, abRating: "AB" },
  { id: "pr111", drugId: "d010", ndc: "00006-0117-31", strength: "10mg", form: "tablet", manufacturer: "Merck (Singulair)", packSize: 30, packUnit: "EA", description: "Singulair 10mg Tab (Merck) 30ct", isGeneric: false, abRating: "AB" },

  // ── Levothyroxine products ──
  { id: "pr120", drugId: "d009", ndc: "00074-6629-90", strength: "100mcg", form: "tablet", manufacturer: "AbbVie (Synthroid)", packSize: 90, packUnit: "EA", description: "Synthroid 100mcg Tab (AbbVie) 90ct", isGeneric: false, abRating: "AB" },
  { id: "pr121", drugId: "d009", ndc: "00378-1810-01", strength: "75mcg", form: "tablet", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Levothyroxine 75mcg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr122", drugId: "d009", ndc: "00378-1812-01", strength: "100mcg", form: "tablet", manufacturer: "Mylan", packSize: 100, packUnit: "EA", description: "Levothyroxine 100mcg Tab (Mylan) 100ct", isGeneric: true, abRating: "AB" },

  // ── Prednisone products ──
  { id: "pr130", drugId: "d017", ndc: "00054-4728-25", strength: "5mg", form: "tablet", manufacturer: "Roxane", packSize: 100, packUnit: "EA", description: "Prednisone 5mg Tab (Roxane) 100ct", isGeneric: true, abRating: "AB" },
  { id: "pr131", drugId: "d017", ndc: "00054-4730-25", strength: "20mg", form: "tablet", manufacturer: "Roxane", packSize: 100, packUnit: "EA", description: "Prednisone 20mg Tab (Roxane) 100ct", isGeneric: true, abRating: "AB" },

  // ── Tramadol products (C-IV) ──
  { id: "pr140", drugId: "d014", ndc: "00045-0659-60", strength: "50mg", form: "tablet", manufacturer: "Amneal", packSize: 100, packUnit: "EA", description: "Tramadol HCl 50mg Tab (Amneal) 100ct", isGeneric: true, abRating: "AB" },
];

const PRESCRIBER_DATABASE = [
  { id: "pr001", firstName: "Sarah", lastName: "Kim", credentials: "MD", dea: "AK1234563", npi: "1234567890", practice: "Front Range Internal Medicine", phone: "(970) 555-1100" },
  { id: "pr002", firstName: "James", lastName: "Park", credentials: "DO", dea: "BP2345674", npi: "2345678901", practice: "Poudre Valley Family Practice", phone: "(970) 555-1200" },
  { id: "pr003", firstName: "Maria", lastName: "Lopez", credentials: "MD", dea: "BL3456785", npi: "3456789012", practice: "Foothills Cardiology", phone: "(970) 555-1300" },
  { id: "pr004", firstName: "Robert", lastName: "Chen", credentials: "NP", dea: "MC4567896", npi: "4567890123", practice: "UCHealth Urgent Care", phone: "(970) 555-1400" },
  { id: "pr005", firstName: "Emily", lastName: "Thompson", credentials: "PA", dea: "FT5678907", npi: "5678901234", practice: "Mountain View Orthopedics", phone: "(970) 555-1500" },
  { id: "pr006", firstName: "Daniel", lastName: "Nguyen", credentials: "DDS", dea: "BN6789018", npi: "6789012345", practice: "Fort Collins Dental Group", phone: "(970) 555-1600" },
];

// ── Mock E-Orders (simulating incoming NCPDP SCRIPT data) ──
// Raw fielded data as it arrives from the prescriber's EHR
// Mutable registry populated by EScriptGeneratorPanel at runtime.
// Both mock getAllEOrders/getEOrder and DataEntryWorkspaceContent read from here.
const RUNTIME_EORDERS = {};

const MOCK_EORDERS = {
  p1: {
    messageId: "MSG-20260226-001",
    receivedAt: "2026-02-26T14:32:00Z",
    // Raw NCPDP-style fields
    raw: {
      messageType: "NEWRX",
      drugDescription: "Norvasc 5mg Oral Tablet",
      drugNDC: "00069-1530-30",
      drugCodedName: "amlodipine besylate",
      drugStrength: "5 mg",
      drugForm: "TAB",
      drugQuantity: "30",
      drugDaysSupply: "30",
      refillsAuthorized: "5",
      substitutionCode: "0",
      sigText: "TAKE 1 TABLET BY MOUTH ONCE DAILY FOR BLOOD PRESSURE",
      sigCode: "1 TAB PO QD",
      prescriberLastName: "Kim",
      prescriberFirstName: "Sarah",
      prescriberDEA: "AK1234563",
      prescriberNPI: "1234567890",
      prescriberPhone: "9705551100",
      prescriberAddress: "200 W Mountain Ave, Fort Collins CO 80521",
      patientLastName: "Johnson",
      patientFirstName: "Margaret",
      patientDOB: "19520315",
      dateWritten: "20260226",
      note: "",
    },
    // Human-readable transcription
    transcribed: {
      drug: "Norvasc (amlodipine) 5mg tablet",
      sig: "Take 1 tablet by mouth once daily for blood pressure",
      qty: 30,
      daySupply: 30,
      refills: 5,
      daw: 0,
      prescriber: "Dr. Sarah Kim, MD",
      prescriberDEA: "AK1234563",
      dateWritten: "02/26/2026",
      patient: "Margaret Johnson",
      patientDOB: "03/15/1952",
    },
  },
  p2: {
    messageId: "MSG-20260226-002",
    receivedAt: "2026-02-26T15:05:00Z",
    raw: {
      messageType: "NEWRX",
      drugDescription: "Singulair 10mg Oral Tablet",
      drugNDC: "00006-0117-31",
      drugCodedName: "montelukast sodium",
      drugStrength: "10 mg",
      drugForm: "TAB",
      drugQuantity: "30",
      drugDaysSupply: "30",
      refillsAuthorized: "11",
      substitutionCode: "0",
      sigText: "TAKE 1 TABLET BY MOUTH AT BEDTIME",
      sigCode: "1 TAB PO QHS",
      prescriberLastName: "Park",
      prescriberFirstName: "James",
      prescriberDEA: "BP2345674",
      prescriberNPI: "2345678901",
      prescriberPhone: "9705551200",
      prescriberAddress: "1100 Lemay Ave, Fort Collins CO 80524",
      patientLastName: "Chen",
      patientFirstName: "David",
      patientDOB: "19850722",
      dateWritten: "20260226",
      note: "Patient reports seasonal allergies worsening",
    },
    transcribed: {
      drug: "Singulair (montelukast) 10mg tablet",
      sig: "Take 1 tablet by mouth at bedtime",
      qty: 30,
      daySupply: 30,
      refills: 11,
      daw: 0,
      prescriber: "Dr. James Park, DO",
      prescriberDEA: "BP2345674",
      dateWritten: "02/26/2026",
      patient: "David Chen",
      patientDOB: "07/22/1985",
      note: "Patient reports seasonal allergies worsening",
    },
  },
  p3: {
    messageId: "MSG-20260226-003",
    receivedAt: "2026-02-26T13:48:00Z",
    raw: {
      messageType: "NEWRX",
      drugDescription: "Toprol-XL 25mg Oral Tablet Extended Release",
      drugNDC: "00186-1092-05",
      drugCodedName: "metoprolol succinate",
      drugStrength: "25 mg",
      drugForm: "TAB,SA",
      drugQuantity: "30",
      drugDaysSupply: "30",
      refillsAuthorized: "5",
      substitutionCode: "0",
      sigText: "TAKE 1 TABLET BY MOUTH ONCE DAILY",
      sigCode: "1 TAB PO QD",
      prescriberLastName: "Lopez",
      prescriberFirstName: "Maria",
      prescriberDEA: "BL3456785",
      prescriberNPI: "3456789012",
      prescriberPhone: "9705551300",
      prescriberAddress: "1024 S Lemay Ave Ste 200, Fort Collins CO 80524",
      patientLastName: "Martinez",
      patientFirstName: "Rosa",
      patientDOB: "19681103",
      dateWritten: "20260225",
      note: "Adding for newly diagnosed HTN - start low dose",
    },
    transcribed: {
      drug: "Toprol-XL (metoprolol succinate) 25mg ER tablet",
      sig: "Take 1 tablet by mouth once daily",
      qty: 30,
      daySupply: 30,
      refills: 5,
      daw: 0,
      prescriber: "Dr. Maria Lopez, MD",
      prescriberDEA: "BL3456785",
      dateWritten: "02/25/2026",
      patient: "Rosa Martinez",
      patientDOB: "11/03/1968",
      note: "Adding for newly diagnosed HTN - start low dose",
    },
  },
};

// ── Drug Matching ──
// Attempts to match an incoming drug description against the local drug file.
// Returns { drug, strength, confidence } or null.
function matchDrugFromEOrder(rawFields) {
  const desc = (rawFields.drugDescription || "").toLowerCase();
  const coded = (rawFields.drugCodedName || "").toLowerCase();
  const incomingStrength = (rawFields.drugStrength || "").replace(/\s/g, "").toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const drug of DRUG_DATABASE) {
    let score = 0;
    const name = drug.name.toLowerCase();
    const brands = drug.brandNames.map(b => b.toLowerCase());

    // Exact generic name match in coded field
    if (coded.includes(name)) score += 50;
    // Generic name in description
    else if (desc.includes(name)) score += 40;
    // Brand name match
    for (const brand of brands) {
      if (desc.includes(brand)) score += 45;
      if (coded.includes(brand)) score += 35;
    }

    // Strength match
    const normalizedStrengths = drug.strengths.map(s => s.replace(/\s/g, "").toLowerCase());
    if (normalizedStrengths.includes(incomingStrength)) score += 20;

    // Form match (loose)
    const rawForm = (rawFields.drugForm || "").toLowerCase();
    const drugForm = drug.form.toLowerCase();
    if (rawForm.includes("tab") && drugForm.includes("tablet")) score += 5;
    if (rawForm.includes("cap") && drugForm.includes("capsule")) score += 5;

    if (score > bestScore) {
      bestScore = score;
      // Find best strength match
      let matchedStrength = drug.strengths[0];
      if (normalizedStrengths.includes(incomingStrength)) {
        const idx = normalizedStrengths.indexOf(incomingStrength);
        matchedStrength = drug.strengths[idx];
      }
      bestMatch = { drug, strength: matchedStrength, score };
    }
  }

  if (!bestMatch || bestMatch.score < 30) return null;

  return {
    drug: bestMatch.drug,
    strength: bestMatch.strength,
    confidence: bestMatch.score >= 60 ? "high" : bestMatch.score >= 40 ? "medium" : "low",
  };
}

// ── Prescriber Matching ──
function matchPrescriberFromEOrder(rawFields) {
  const dea = (rawFields.prescriberDEA || "").toUpperCase();
  const npi = rawFields.prescriberNPI || "";
  const lastName = (rawFields.prescriberLastName || "").toLowerCase();

  // DEA match is strongest
  if (dea) {
    const match = PRESCRIBER_DATABASE.find(p => p.dea.toUpperCase() === dea);
    if (match) return { prescriber: match, confidence: "high" };
  }
  // NPI match
  if (npi) {
    const match = PRESCRIBER_DATABASE.find(p => p.npi === npi);
    if (match) return { prescriber: match, confidence: "high" };
  }
  // Last name fallback
  if (lastName) {
    const matches = PRESCRIBER_DATABASE.filter(p => p.lastName.toLowerCase() === lastName);
    if (matches.length === 1) return { prescriber: matches[0], confidence: "medium" };
  }
  return null;
}


// ── Mock Data Provider Implementation ──
function createMockDataProvider() {
  return {
    searchDrugs: (query, limit = 12) => {
      if (!query || query.length < 2) return [];

      // ── Comma-delimited multi-field search: name,strength,form ──
      const parts = query.split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
      const nameQ = parts[0] || "";
      const strengthQ = parts[1] || "";
      const formQ = parts[2] || "";

      if (nameQ.length < 2) return [];

      return DRUG_DATABASE
        .filter(d => {
          // Name/brand match (required)
          const nameMatch = d.name.toLowerCase().includes(nameQ) ||
            d.brandNames.some(b => b.toLowerCase().includes(nameQ)) ||
            d.drugClass.toLowerCase().includes(nameQ);
          if (!nameMatch) return false;

          // Strength filter (if provided)
          if (strengthQ) {
            const hasStrength = d.strengths.some(s => s.toLowerCase().includes(strengthQ));
            if (!hasStrength) return false;
          }

          // Form filter (if provided)
          if (formQ) {
            const formLower = d.form.toLowerCase();
            if (!formLower.includes(formQ)) return false;
          }

          return true;
        })
        .map(d => {
          // Relevance scoring
          let score = 100;
          const name = d.name.toLowerCase();
          if (name === nameQ) score = 0;
          else if (name.startsWith(nameQ)) score = 10;
          else if (name.split(/[\s\/\-]/).some(w => w.startsWith(nameQ))) score = 20;
          else if (d.brandNames.some(b => b.toLowerCase().startsWith(nameQ))) score = 30;
          else if (d.brandNames.some(b => b.toLowerCase().includes(nameQ))) score = 40;
          else if (name.includes(nameQ)) score = 50;
          else score = 60;

          // Find best matching strength for display hint
          let matchedStrength = null;
          if (strengthQ) {
            matchedStrength = d.strengths.find(s => s.toLowerCase() === strengthQ) ||
              d.strengths.find(s => s.toLowerCase().startsWith(strengthQ)) ||
              d.strengths.find(s => s.toLowerCase().includes(strengthQ));
            if (matchedStrength) score -= 5; // boost exact strength matches
          }

          return { ...d, _score: score, _matchedStrength: matchedStrength };
        })
        .sort((a, b) => a._score - b._score || a.name.localeCompare(b.name))
        .slice(0, limit);
    },

    searchPrescribers: (query) => {
      if (!query || query.length < 2) return [];
      const q = query.toLowerCase();
      return PRESCRIBER_DATABASE
        .filter(p =>
          `${p.firstName} ${p.lastName}`.toLowerCase().includes(q) ||
          p.lastName.toLowerCase().includes(q) ||
          p.dea.toLowerCase().includes(q) ||
          p.npi.includes(q) ||
          p.practice.toLowerCase().includes(q)
        )
        .map(p => {
          let score = 100;
          const last = p.lastName.toLowerCase();
          const full = `${p.firstName} ${p.lastName}`.toLowerCase();
          if (last === q) score = 0;
          else if (last.startsWith(q)) score = 10;
          else if (full.startsWith(q)) score = 15;
          else if (p.dea.toLowerCase().startsWith(q) || p.npi.startsWith(q)) score = 20;
          else if (last.includes(q)) score = 30;
          else score = 50;
          return { ...p, _score: score };
        })
        .sort((a, b) => a._score - b._score || a.lastName.localeCompare(b.lastName))
        .slice(0, 8);
    },

    getDrug: (id) => DRUG_DATABASE.find(d => d.id === id) || null,
    getPrescriber: (id) => PRESCRIBER_DATABASE.find(p => p.id === id) || null,
    getProduct: (id) => PRODUCT_DATABASE.find(p => p.id === id) || null,
    getProductByNdc: (ndc) => PRODUCT_DATABASE.find(p => p.ndc.replace(/-/g, "") === ndc.replace(/-/g, "")) || null,
    getProductsForDrug: (drugId, strength) => {
      return PRODUCT_DATABASE
        .filter(p => p.drugId === drugId && (!strength || p.strength === strength))
        .sort((a, b) => {
          // Generics first, then by manufacturer name
          if (a.isGeneric !== b.isGeneric) return a.isGeneric ? -1 : 1;
          return a.manufacturer.localeCompare(b.manufacturer);
        });
    },

    // E-Order methods
    // Returns a Promise so callers can use the same async interface as TauriDataProvider
    getEOrder: (patientId) => Promise.resolve(MOCK_EORDERS[patientId] || RUNTIME_EORDERS[patientId] || null),

    getAllEOrders: () => {
      const orders = [
        ...Object.entries(MOCK_EORDERS).map(([patientId, eOrder]) => ({ ...eOrder, patientId })),
        ...Object.values(RUNTIME_EORDERS),
      ].sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
      return Promise.resolve(orders);
    },

    markEOrderResolved: (_id) => Promise.resolve(),

    ingestEOrderXml: (_xml, _patientId) => Promise.resolve(null),
    generateEScripts: (_apiKey) => Promise.reject(new Error("CORS — run in Tauri app")),

    resolveEOrder: (eOrder) => {
      // Attempt to auto-match drug and prescriber from e-order fields
      const drugMatch = matchDrugFromEOrder(eOrder.raw);
      const prescriberMatch = matchPrescriberFromEOrder(eOrder.raw);
      return {
        drug: drugMatch,        // { drug, strength, confidence } | null
        prescriber: prescriberMatch, // { prescriber, confidence } | null
        qty: parseInt(eOrder.raw.drugQuantity, 10) || null,
        daySupply: parseInt(eOrder.raw.drugDaysSupply, 10) || null,
        refills: parseInt(eOrder.raw.refillsAuthorized, 10) ?? null,
        daw: parseInt(eOrder.raw.substitutionCode, 10) || 0,
        sig: eOrder.transcribed.sig || eOrder.raw.sigText || "",
      };
    },

    // Validation helpers the form can call
    getRefillLimit: (schedule) => {
      if (schedule === "C-II") return 0;
      if (schedule === "C-III" || schedule === "C-IV" || schedule === "C-V") return 5;
      return 99; // No legal limit for non-controlled
    },

    getScheduleLabel: (schedule) => {
      const labels = { "C-II": "Schedule II", "C-III": "Schedule III", "C-IV": "Schedule IV", "C-V": "Schedule V", "Rx": "Rx Only", "OTC": "OTC" };
      return labels[schedule] || schedule;
    },

    // Rx Engine stubs (frontend-only mode)
    getUsers: async () => [
      { id: "usr-tech-1", name: "Alex Chen",      role: "tech" },
      { id: "usr-tech-2", name: "Jordan Mills",    role: "tech" },
      { id: "usr-rph-1",  name: "Dr. Sarah Park",  role: "rph"  },
      { id: "usr-rph-2",  name: "Dr. Marcus Webb", role: "rph"  },
    ],
    getActivePrescriptions: async () => [],
    getAllPrescriptions: async () => [],
    getPrescriptionsByStatus: async () => [],
    sellPrescription: async () => null,
    createPrescription: async (patientId) => ({
      id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      rxNumber: null, patientId, status: "incoming", scheduleClass: null,
      eorderData: null, techEntryData: null, rphReviewData: null,
      fillData: null, rphFillReviewData: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }),
    transitionRx: async (rxId, action) => {
      const statusMap = {
        START_ENTRY: "in_entry", SUBMIT_RX: "pending_review", RESUBMIT_RX: "pending_review",
        RPH_APPROVE: "approved", RPH_RETURN: "returned", RPH_CALL: "call_prescriber",
        RESOLVE_CALL: "pending_review", START_FILL: "in_fill",
        SUBMIT_FILL: "pending_fill_verify", RPH_VERIFY_FILL: "ready", RPH_REJECT_FILL: "in_fill",
      };
      const rxNumber = action === "RPH_APPROVE"
        ? `700${String(Date.now() % 100000).padStart(5, "0")}` : null;
      return { rxId, oldStatus: null, newStatus: statusMap[action] || "unknown", rxNumber, timestamp: new Date().toISOString() };
    },
    getPrescription: async () => null,
    getInventoryBatch: async () => [],
    getPrescriptionsByPatient: async () => [],
    getQueueCounts: async () => ({}),
    getEventsByRx: async () => [],
    getPatient: async () => null,
    upsertPatient: async (patient) => patient,
    getAllPatients: async () => [],
    searchPatients: async () => [],
    getFillHistory: async () => [],
    appendFillHistory: async (entry) => entry,
  };
}


// ============================================================
// CONSTANTS & CONFIG
// ============================================================
const WORKSPACE_COLORS = [
  { name: "Ruby", bg: "#e45858", light: "#1f1418", mid: "#2d1a1e", border: "#3d2228", text: "#f0a0a0" },
  { name: "Ocean", bg: "#5b8af5", light: "#141a24", mid: "#1a2236", border: "#223050", text: "#a0bff0" },
  { name: "Emerald", bg: "#4abe6a", light: "#141f18", mid: "#1a2d20", border: "#223d28", text: "#90e0a0" },
  { name: "Amber", bg: "#e8a030", light: "#1f1a14", mid: "#2d2418", border: "#3d3020", text: "#f0d090" },
  { name: "Violet", bg: "#9b6ef0", light: "#1a1424", mid: "#221a36", border: "#302250", text: "#c0a0f0" },
  { name: "Rose", bg: "#f06088", light: "#1f1418", mid: "#2d1a22", border: "#3d2230", text: "#f0a0b8" },
  { name: "Teal", bg: "#40c0b0", light: "#141f1e", mid: "#1a2d2a", border: "#223d38", text: "#90e0d0" },
  { name: "Slate", bg: "#7088a8", light: "#181a1e", mid: "#1e2228", border: "#283040", text: "#a8b8d0" },
];

const NEUTRAL_WS_COLOR = { name: "", bg: "#64748b", light: "#171b22", mid: "#1c2030", border: "#252b3a", text: "#94a3b8" };
const NEUTRAL_TASK_COLOR = "#64748b";

const TAB_TYPES = {
  RX_ENTRY: { label: "Rx Entry", icon: "Rx" },
  RPH_VERIFY: { label: "RPh Verify", icon: "Rv" },
  FILL: { label: "Fill", icon: "Fl" },
  FILL_VERIFY: { label: "Fill Verify", icon: "Fv" },
  DATA_ENTRY_WS: { label: "Data Entry", icon: "De" },
  PATIENT_PROFILE: { label: "Patient Profile", icon: "Pt" },
  MED_HISTORY: { label: "Med History", icon: "Hx" },
  INSURANCE: { label: "Insurance", icon: "Ins" },
  ALLERGIES: { label: "Allergies", icon: "Al" },
  NOTES: { label: "Notes", icon: "Nt" },
  INVENTORY: { label: "Inventory", icon: "Inv" },
  RX_HISTORY: { label: "Rx History", icon: "Hx" },
  PICKUP: { label: "Pickup", icon: "Pk" },
  DRUG_SEARCH: { label: "Drug Browser", icon: "Db" },
  PRESCRIBER_DIR: { label: "Prescribers", icon: "Dr" },
  PRESCRIBER_CARD: { label: "Prescriber", icon: "Dr" },
  SOLD: { label: "Dispensed", icon: "✓" },
  PATIENT_MAINTENANCE: { label: "Patients", icon: "Pt" },
};

const GRID_COLS = 12;
const GRID_ROWS = 8;
const SNAP_SIZES = {
  FULL:    { cols: GRID_COLS, rows: GRID_ROWS, label: "Full"    },
  HALF_H:  { cols: Math.ceil(GRID_COLS / 2), rows: GRID_ROWS, label: "Half"    },
  HALF_V:  { cols: GRID_COLS, rows: Math.ceil(GRID_ROWS / 2), label: "Half-V"  },
  QUARTER: { cols: Math.ceil(GRID_COLS / 2), rows: Math.ceil(GRID_ROWS / 2), label: "Quarter" },
  THIRD:   { cols: Math.floor(GRID_COLS / 3), rows: GRID_ROWS, label: "Third"   },
};

const DAW_CODES = [
  { value: 0, label: "0 — No product selection indicated" },
  { value: 1, label: "1 — Substitution not allowed by prescriber" },
  { value: 2, label: "2 — Patient requested brand" },
  { value: 3, label: "3 — Pharmacist selected brand" },
  { value: 4, label: "4 — Generic not in stock" },
  { value: 5, label: "5 — Brand dispensed as generic" },
  { value: 7, label: "7 — Brand mandated by law" },
  { value: 8, label: "8 — Generic not available" },
  { value: 9, label: "9 — Other" },
];

// ============================================================
// MOCK PATIENT DATA
// ============================================================
const MOCK_PATIENTS = [
  {
    id: "p1", name: "Margaret Johnson", firstName: "Margaret", lastName: "Johnson", dob: "03/15/1952",
    phone: "(970) 555-0142", address: "412 Maple St, Fort Collins, CO 80521",
    address1: "412 Maple St", address2: "", city: "Fort Collins", state: "CO", zip: "80521",
    allergies: ["Penicillin", "Sulfa drugs"],
    insurance: { plan: "Blue Cross Blue Shield", memberId: "BCB-882741", group: "GRP-4401", copay: "$10/$30/$50" },
    medications: [
      { name: "Lisinopril 10mg", directions: "Take 1 tablet daily", qty: 30, refills: 5, lastFill: "2026-01-15" },
      { name: "Metformin 500mg", directions: "Take 1 tablet twice daily", qty: 60, refills: 3, lastFill: "2026-01-20" },
      { name: "Atorvastatin 20mg", directions: "Take 1 tablet at bedtime", qty: 30, refills: 11, lastFill: "2026-02-01" },
    ],
    notes: "Prefers afternoon pickup. Hard of hearing — speak clearly. Daughter (Lisa) sometimes picks up.",
  },
  {
    id: "p2", name: "David Chen", firstName: "David", lastName: "Chen", dob: "07/22/1985",
    phone: "(970) 555-0287", address: "1890 College Ave, Fort Collins, CO 80524",
    address1: "1890 College Ave", address2: "", city: "Fort Collins", state: "CO", zip: "80524",
    allergies: ["Codeine"],
    insurance: { plan: "Aetna PPO", memberId: "AET-339102", group: "GRP-7782", copay: "$5/$25/$45" },
    medications: [
      { name: "Escitalopram 10mg", directions: "Take 1 tablet daily", qty: 30, refills: 5, lastFill: "2026-02-10" },
      { name: "Omeprazole 20mg", directions: "Take 1 capsule before breakfast", qty: 30, refills: 2, lastFill: "2026-01-28" },
    ],
    notes: "Requests generic when available. Works remotely — flexible pickup times.",
  },
  {
    id: "p3", name: "Rosa Martinez", firstName: "Rosa", lastName: "Martinez", dob: "11/03/1968",
    phone: "(970) 555-0391", address: "2205 Timberline Rd, Fort Collins, CO 80525",
    address1: "2205 Timberline Rd", address2: "", city: "Fort Collins", state: "CO", zip: "80525",
    allergies: ["Aspirin", "NSAIDs", "Latex"],
    insurance: { plan: "Medicare Part D - SilverScript", memberId: "MBI-1H4TE92", group: "N/A", copay: "$3.35/$9.85" },
    medications: [
      { name: "Amlodipine 5mg", directions: "Take 1 tablet daily", qty: 30, refills: 6, lastFill: "2026-02-05" },
      { name: "Levothyroxine 75mcg", directions: "Take 1 tablet every morning on empty stomach", qty: 30, refills: 5, lastFill: "2026-02-05" },
      { name: "Gabapentin 300mg", directions: "Take 1 capsule three times daily", qty: 90, refills: 3, lastFill: "2026-01-25" },
      { name: "Vitamin D3 2000IU", directions: "Take 1 tablet daily", qty: 30, refills: 11, lastFill: "2026-02-01" },
    ],
    notes: "Spanish speaking — prefers bilingual staff. Has difficulty with child-resistant caps. Diabetic — monitor for interactions.",
  },
];


// ============================================================
// INLINE SEARCH COMPONENT (reused for drug + prescriber)
// ============================================================
function InlineSearch({ placeholder, onSearch, onSelect, renderItem, renderSelected, selected, color, autoFocus, tabIndex, onExpandSearch }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [hlIndex, setHlIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const hlRef = useRef(null);

  const MAX_VISIBLE = 15;
  const displayResults = showAll ? results : results.slice(0, MAX_VISIBLE);

  // Scroll highlighted item into view when navigating with arrow keys
  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: "nearest" });
  }, [hlIndex]);

  useEffect(() => {
    setShowAll(false);
    if (query.length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const result = onSearch(query);
      if (result && typeof result.then === 'function') {
        result.then(r => {
          if (cancelled) return;
          setResults(r || []);
          setOpen((r || []).length > 0);
          setHlIndex(0);
        });
      } else {
        if (cancelled) return;
        setResults(result || []);
        setOpen((result || []).length > 0);
        setHlIndex(0);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, onSearch]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (item) => {
    onSelect(item);
    setQuery("");
    setOpen(false);
    setShowAll(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setHlIndex(i => Math.min(i + 1, displayResults.length - 1));
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setHlIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && displayResults[hlIndex]) {
      e.preventDefault();
      handleSelect(displayResults[hlIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !query && selected) {
      onSelect(null);
    }
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onSelect(null);
    setQuery("");
    if (inputRef.current) inputRef.current.focus();
  };

  const handleGlassClick = (e) => {
    e.stopPropagation();
    if (onExpandSearch) {
      onExpandSearch(query);
      return;
    }
    if (query.length < 3) {
      inputRef.current?.focus();
      return;
    }
    setShowAll(true);
    const result = onSearch(query);
    if (result && typeof result.then === 'function') {
      result.then(r => {
        setResults(r || []);
        setOpen((r || []).length > 0);
        setHlIndex(0);
      });
    } else {
      setResults(result || []);
      setOpen((result || []).length > 0);
      setHlIndex(0);
    }
  };

  if (selected) {
    return (
      <div
        tabIndex={tabIndex || 0}
        onKeyDown={(e) => {
          if (e.key === "Tab") return; // let Tab pass through naturally
          if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            onSelect(null);
            setTimeout(() => inputRef.current?.focus(), 0);
          } else if (e.key === "Enter" || e.key === " " || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
            e.preventDefault();
            onSelect(null);
            // If it was a character key, seed the search with it
            if (e.key.length === 1 && e.key !== " ") {
              setQuery(e.key);
            }
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        onClick={() => { onSelect(null); setTimeout(() => inputRef.current?.focus(), 0); }}
        style={{
          width: "100%", padding: "7px 10px", borderRadius: 6,
          border: `1.5px solid ${color.border}60`, background: color.light,
          fontSize: 13, fontFamily: T.mono,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: "pointer", color: T.textPrimary, minHeight: 36, boxSizing: "border-box",
          outline: "none",
        }}
        onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; e.target.style.boxShadow = `0 0 0 2px ${color.bg}20`; }}
        onBlur={(e) => { e.target.style.borderColor = color.border + "60"; e.target.style.boxShadow = "none"; }}
      >
        <div style={{ flex: 1, overflow: "hidden" }}>{renderSelected(selected)}</div>
        <span onClick={handleClear} style={{ color: T.textSecondary, cursor: "pointer", fontSize: 14, padding: "0 2px", marginLeft: 8, flexShrink: 0 }}>×</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      {/* Magnifier icon */}
      <button
        type="button"
        onClick={handleGlassClick}
        title={onExpandSearch ? "Open Drug Browser" : "Show all results"}
        style={{
          position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)",
          background: "none", border: "none", padding: 0, cursor: "pointer",
          color: (onExpandSearch || query.length >= 3) ? color.bg : T.textMuted,
          display: "flex", alignItems: "center", zIndex: 1,
          transition: "color 0.15s",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </button>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        tabIndex={tabIndex}
        style={{
          width: "100%", padding: "7px 10px 7px 28px", borderRadius: 6,
          border: `1px solid ${open ? color.bg + "60" : T.inputBorder}`, background: T.surfaceRaised,
          color: T.textPrimary, fontSize: 13, fontFamily: T.mono,
          outline: "none", boxSizing: "border-box", minHeight: 36,
          transition: "border-color 0.15s",
        }}
      />
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0,
          background: T.surfaceRaised, border: `1.5px solid ${color.border}60`,
          borderRadius: 8, overflow: "hidden", zIndex: 200,
          boxShadow: `0 8px 30px ${color.bg}20, 0 2px 8px rgba(0,0,0,0.08)`,
          maxHeight: showAll ? 400 : 220, overflowY: "auto",
        }}>
          {displayResults.map((item, i) => (
            <div
              key={item.id}
              ref={i === hlIndex ? hlRef : null}
              onClick={() => handleSelect(item)}
              onMouseEnter={() => setHlIndex(i)}
              style={{
                padding: "8px 12px", cursor: "pointer",
                background: i === hlIndex ? color.light : "transparent",
                borderBottom: `1px solid ${T.surfaceBorder}`,
                transition: "background 0.1s",
              }}
            >
              {renderItem(item, i === hlIndex)}
            </div>
          ))}
          {!showAll && results.length > MAX_VISIBLE && (
            <div
              onClick={handleGlassClick}
              style={{
                padding: "6px 12px", textAlign: "center", cursor: "pointer",
                color: color.bg, fontSize: 11, fontFamily: T.mono,
                borderTop: `1px solid ${T.surfaceBorder}`,
                background: "transparent",
              }}
            >
              +{results.length - MAX_VISIBLE} more — click 🔍 to expand
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── DrugSearch — press Enter to search, no live debounce ──────────────────
// Accepts "name,strength,form" or NDC (starts with digit → resolved on Enter).
// NDC results auto-select. Drug name results show a picker list.
function DrugSearch({ onSearch, onSelect, renderItem, renderSelected, selected, color, autoFocus, tabIndex }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [hlIndex, setHlIndex] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const hlRef = useRef(null);

  useEffect(() => { hlRef.current?.scrollIntoView({ block: 'nearest' }); }, [hlIndex]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const runSearch = async (q) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSearching(true);
    setResults([]);
    setOpen(false);
    try {
      const list = (await Promise.resolve(onSearch(trimmed))) || [];
      // NDC exact match → auto-select, skip the picker entirely
      if (list.length === 1 && list[0]._fromNdc) {
        onSelect(list[0]);
        setQuery('');
        return;
      }
      setResults(list);
      setOpen(list.length > 0);
      setHlIndex(0);
    } catch (e) {
      console.error('DrugSearch error:', e);
    } finally {
      setSearching(false);
    }
  };

  const handleSelect = (item) => { onSelect(item); setQuery(''); setResults([]); setOpen(false); };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (open && results[hlIndex]) handleSelect(results[hlIndex]);
      else runSearch(query);
    } else if (e.key === 'ArrowDown' && open) { e.preventDefault(); setHlIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setHlIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'Backspace' && !query && selected) onSelect(null);
  };

  if (selected) {
    return (
      <div
        tabIndex={tabIndex || 0}
        onClick={() => { onSelect(null); setTimeout(() => inputRef.current?.focus(), 0); }}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); onSelect(null); }
          else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            e.preventDefault(); onSelect(null); setQuery(e.key);
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        style={{
          width: '100%', padding: '7px 10px', borderRadius: 6,
          border: `1.5px solid ${color.border}60`, background: color.light,
          fontSize: 13, fontFamily: T.mono, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', cursor: 'pointer', color: T.textPrimary,
          minHeight: 36, boxSizing: 'border-box', outline: 'none',
        }}
        onFocus={(e) => { e.target.style.borderColor = color.bg + '80'; }}
        onBlur={(e) => { e.target.style.borderColor = color.border + '60'; }}
      >
        <div style={{ flex: 1, overflow: 'hidden' }}>{renderSelected(selected)}</div>
        <span onClick={(e) => { e.stopPropagation(); onSelect(null); setTimeout(() => inputRef.current?.focus(), 0); }}
          style={{ color: T.textSecondary, cursor: 'pointer', fontSize: 14, padding: '0 2px', marginLeft: 8, flexShrink: 0 }}>×</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <div style={{ position: 'relative' }}>
        <span style={{
          position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
          color: searching ? color.bg : T.textMuted, fontSize: 13, pointerEvents: 'none',
        }}>{searching ? '…' : '⌕'}</span>
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          tabIndex={tabIndex}
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (!e.target.value) { setResults([]); setOpen(false); } }}
          onKeyDown={handleKeyDown}
          placeholder="name,strength,form  or  NDC — press ↵"
          style={{
            width: '100%', padding: '7px 10px 7px 28px', borderRadius: 6,
            border: `1px solid ${open ? color.bg + '60' : T.inputBorder}`, background: T.surfaceRaised,
            color: T.textPrimary, fontSize: 13, fontFamily: T.mono,
            outline: 'none', boxSizing: 'border-box', minHeight: 36, transition: 'border-color 0.15s',
          }}
        />
      </div>
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
          background: T.surfaceRaised, border: `1.5px solid ${color.border}60`,
          borderRadius: 8, overflow: 'hidden', zIndex: 200,
          boxShadow: `0 8px 30px ${color.bg}20, 0 2px 8px rgba(0,0,0,0.2)`,
          maxHeight: 300, overflowY: 'auto',
        }}>
          {results.map((item, i) => (
            <div key={item.id} ref={i === hlIndex ? hlRef : null}
              onClick={() => handleSelect(item)} onMouseEnter={() => setHlIndex(i)}
              style={{
                padding: '8px 12px', cursor: 'pointer',
                background: i === hlIndex ? color.light : 'transparent',
                borderBottom: `1px solid ${T.surfaceBorder}`, transition: 'background 0.1s',
              }}>
              {renderItem(item, i === hlIndex)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// E-SCRIPT PANEL — Formatted prescription document, used in all workflow tiles
// ============================================================
function EScriptPanel({ eOrder, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [showRaw, setShowRaw] = useState(false);

  if (!eOrder) return null;

  const t = eOrder.transcribed || {};
  const r = eOrder.raw || {};
  const receivedTime = eOrder.receivedAt
    ? new Date(eOrder.receivedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  const patientName = t.patient || `${r.patientFirstName || ""} ${r.patientLastName || ""}`.trim() || "—";
  const patientDOB = t.patientDOB || (r.patientDOB ? r.patientDOB : null);
  const prescriberName = t.prescriber || `${r.prescriberFirstName || ""} ${r.prescriberLastName || ""}`.trim() || "—";

  const fieldRow = (label, value) => (
    <div style={{ display: "flex", gap: 0, alignItems: "baseline" }}>
      <span style={{ color: T.textMuted, minWidth: 72, flexShrink: 0, fontSize: 10 }}>{label}</span>
      <span style={{ color: T.textPrimary, fontSize: 11 }}>{value || "—"}</span>
    </div>
  );

  return (
    <div style={{ marginBottom: 10, fontFamily: T.mono }}>
      {/* Toggle header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 8,
          padding: "7px 10px", borderRadius: open ? "6px 6px 0 0" : 6,
          border: `1px solid ${T.surfaceBorder}`, background: T.surface,
          cursor: "pointer", fontFamily: T.mono, textAlign: "left",
        }}
      >
        <span style={{
          fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
          color: "#60a5fa", flex: 1,
        }}>
          ◑ E-Script {eOrder.messageId || ""}
        </span>
        <span style={{ fontSize: 10, color: T.textMuted }}>{receivedTime}</span>
        <span style={{ fontSize: 10, color: T.textMuted, marginLeft: 6 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{
          border: `1px solid ${T.surfaceBorder}`, borderTop: "none",
          borderRadius: "0 0 6px 6px", background: T.inputBg,
        }}>
          {/* Patient */}
          <div style={{ padding: "9px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
            <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: T.textMuted, marginBottom: 4 }}>Patient</div>
            <div style={{ fontSize: 12, color: T.textPrimary, fontWeight: 600 }}>{patientName}</div>
            {patientDOB && <div style={{ fontSize: 10, color: T.textSecondary, marginTop: 1 }}>DOB: {patientDOB}</div>}
          </div>

          {/* Prescriber */}
          <div style={{ padding: "9px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
            <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: T.textMuted, marginBottom: 4 }}>Prescriber</div>
            <div style={{ fontSize: 12, color: T.textPrimary, fontWeight: 600 }}>{prescriberName}</div>
            <div style={{ marginTop: 3, lineHeight: 1.7 }}>
              {r.prescriberDEA && fieldRow("DEA", r.prescriberDEA)}
              {r.prescriberNPI && fieldRow("NPI", r.prescriberNPI)}
              {r.prescriberPhone && fieldRow("Phone", r.prescriberPhone)}
            </div>
          </div>

          {/* Drug */}
          <div style={{ padding: "9px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
            <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: T.textMuted, marginBottom: 4 }}>Medication</div>
            <div style={{ fontSize: 12, color: T.textPrimary, fontWeight: 700 }}>{t.drug || r.drugDescription || "—"}</div>
            {r.drugNDC && <div style={{ fontSize: 10, color: T.textMuted, marginTop: 1 }}>NDC: {r.drugNDC}</div>}
            <div style={{ marginTop: 5, lineHeight: 1.7 }}>
              {fieldRow("SIG", t.sig || r.sigText)}
              <div style={{ display: "flex", gap: 0 }}>
                <span style={{ color: T.textMuted, minWidth: 72, flexShrink: 0, fontSize: 10 }}>Qty</span>
                <span style={{ color: T.textPrimary, fontSize: 11 }}>
                  {t.qty ?? r.drugQuantity ?? "—"}
                  <span style={{ color: T.textMuted, marginLeft: 10 }}>DS: {t.daySupply ?? r.drugDaysSupply ?? "—"}</span>
                  <span style={{ color: T.textMuted, marginLeft: 10 }}>Refills: {t.refills ?? r.refillsAuthorized ?? "—"}</span>
                  <span style={{ color: T.textMuted, marginLeft: 10 }}>DAW: {t.daw ?? r.substitutionCode ?? "—"}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{ padding: "7px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: T.textMuted }}>Written: {t.dateWritten || r.dateWritten || "—"}</span>
            <span style={{ fontSize: 10, color: T.textMuted }}>{r.messageType || "NewRx"}</span>
          </div>

          {/* Note */}
          {(t.note || r.note) && (
            <div style={{ padding: "6px 12px 8px", borderTop: `1px solid ${T.surfaceBorder}`, fontSize: 10, color: T.textSecondary }}>
              <strong>Note:</strong> {t.note || r.note}
            </div>
          )}

          {/* Raw fields toggle */}
          <button
            onClick={() => setShowRaw(s => !s)}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 6,
              padding: "5px 12px", border: "none", borderTop: `1px solid ${T.surfaceBorder}`,
              background: "transparent", cursor: "pointer", fontSize: 9,
              color: T.textMuted, fontFamily: T.mono, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: 0.5,
            }}
          >
            <span style={{ transform: showRaw ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 0.15s" }}>▸</span>
            Raw NCPDP Fields
          </button>
          {showRaw && (
            <div style={{
              padding: "6px 12px 10px", borderTop: `1px solid ${T.surfaceBorder}`,
              maxHeight: 200, overflowY: "auto",
            }}>
              {Object.entries(r).map(([key, value]) => (
                <div key={key} style={{ display: "flex", gap: 8, borderBottom: `1px solid #e2e8f010`, padding: "2px 0" }}>
                  <span style={{ color: T.textSecondary, minWidth: 160, flexShrink: 0, fontSize: 10 }}>{key}</span>
                  <span style={{ color: T.textPrimary, fontSize: 10, wordBreak: "break-all" }}>{value || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// RX ENTRY FORM — The real thing
// ============================================================
function RxEntryContent({ patient, workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo, currentUser } = useContext(PharmIDEContext);
  const { storeDispatch, searchPrescribers } = useData();
  const color = workspace.color;
  const rxState = workspace.rxPrescription;

  // ── E-Order loading (async, with workspace-attached fallback) ──
  // workspace.pendingEOrder is attached at open-time from the queue preview
  // so the e-script is immediately available without waiting for DB lookup.
  const [eOrder, setEOrder] = useState(workspace.pendingEOrder || null);
  useEffect(() => {
    let mounted = true;
    Promise.resolve(data.getEOrder(patient.id)).then(eo => {
      if (mounted) setEOrder(eo || workspace.pendingEOrder || null);
    }).catch(() => {});
    return () => { mounted = false; };
  }, [patient.id, data, workspace.pendingEOrder]);
  const resolved = useMemo(() => eOrder ? data.resolveEOrder(eOrder) : null, [eOrder, data]);

  // ── Form state ──
  const [drug, setDrug] = useState(null);
  const [strength, setStrength] = useState("");
  const [product, setProduct] = useState(null);
  const [prescriber, setPrescriber] = useState(null);
  const [qty, setQty] = useState("");
  const [daySupply, setDaySupply] = useState("");
  const [refills, setRefills] = useState("");
  const [daw, setDaw] = useState(0);
  const [sig, setSig] = useState("");
  const [origRxText, setOrigRxText] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [showRawFields, setShowRawFields] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // ── Apply selection from Drug Browser tile ──
  useEffect(() => {
    const sel = workspace.pendingDrugSelection;
    if (!sel) return;
    const { drug: d, product: p } = sel;
    skipNextStrengthReset.current = true;
    setDrug(d);
    setStrength(d._matchedStrength || d.strengths?.[0] || "");
    setProduct(p);
    if (d.id) storeDispatch({ type: 'ENTITY_UPDATED', entityType: 'drug', entityId: d.id, data: d });
    dispatch({ type: "CLEAR_DRUG_SELECTION", workspaceId: workspace.id });
  }, [workspace.pendingDrugSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Create prescription record in DB when workspace first opens ──
  useEffect(() => {
    if (!currentUser || rxState !== null) return;
    data.createPrescription(patient.id, JSON.stringify(eOrder || {}), currentUser.id)
      .then(prescription => {
        if (prescription) {
          dispatch({ type: "INIT_PRESCRIPTION", workspaceId: workspace.id, prescription });
          syncRxToStore(prescription.id, data, storeDispatch);
        }
      });
  }, [currentUser?.id, workspace.id]); // intentionally omit eOrder (stable memo)

  // ── Fire START_ENTRY as soon as prescription record exists ──
  useEffect(() => {
    if (!currentUser || !rxState?.id || rxState.status !== "incoming") return;
    data.transitionRx(rxState.id, "START_ENTRY", currentUser.id, currentUser.role, "{}")
      .then(result => {
        if (result) {
          dispatch({ type: "SET_RX_STATUS", workspaceId: workspace.id, status: result.newStatus });
          syncRxToStore(rxState.id, data, storeDispatch);
        }
      });
  }, [rxState?.id, rxState?.status]); // intentionally minimal deps

  // ── Auto-populate from e-order on first render ──
  useEffect(() => {
    if (initialized || !resolved) return;
    if (resolved.drug) {
      setDrug(resolved.drug.drug);
      setStrength(resolved.drug.strength);
    }
    if (resolved.prescriber) {
      setPrescriber(resolved.prescriber.prescriber);
    }
    if (resolved.qty != null) setQty(String(resolved.qty));
    if (resolved.daySupply != null) setDaySupply(String(resolved.daySupply));
    if (resolved.refills != null) setRefills(String(resolved.refills));
    if (resolved.daw != null) setDaw(resolved.daw);
    if (resolved.sig) setSig(resolved.sig);
    setInitialized(true);
  }, [resolved, initialized]);

  // ── Validation ──
  // ── Extract dosage form from the strength string ──
  // Tauri strengths embed form after the numeric+unit part:
  //   "500mg tablet"          → "tablet"
  //   "500 MG TAB"            → "TAB"
  //   "500mg/5ml oral solution" → "oral solution"
  // Mock strengths are plain ("500mg") so this returns null and falls back to drug.form.
  const extractedForm = useMemo(() => {
    if (!strength) return null;
    // Strip leading numeric / unit / slash-unit block, then take the rest as form
    const stripped = strength
      .replace(/^[\d./]+\s*(?:mg|mcg|ml|g|IU|units?|mEq|MG|MCG|ML|G)?(?:\/[\d.]+\s*(?:mg|mcg|ml|g|MG|MCG|ML|G)?)?\s*/i, '')
      .trim();
    return stripped || null;
  }, [strength]);

  // ── NDC-aware drug search ──
  const searchDrugOrNdc = useCallback(async (query) => {
    // Starts with a digit → NDC mode: resolve immediately
    if (/^\d/.test(query)) {
      const product = await data.getProductByNdc(query);
      if (!product) return [];
      const digits = query.replace(/\D/g, '');
      const drugId = 'ndc-' + digits;
      const nameMatch = product.description?.match(/^([^(]+?)(?:\s+[\d.]|\s*\()/);
      const drugName = nameMatch ? nameMatch[1].trim() : (product.description || '').split(' ')[0] || 'Unknown';
      return [{
        id: drugId, name: drugName, brandNames: [], strengths: [product.strength],
        form: product.form, route: 'oral', schedule: 'Rx',
        drugClass: product.manufacturer || '',
        _matchedStrength: product.strength,
        _fromNdc: true, _ndc: query,
        _product: { ...product, drugId },
      }];
    }
    return data.searchDrugs(query);
  }, [data]);

  // ── Available products + on-hand quantities ──
  const [availableProducts, setAvailableProducts] = useState([]);
  const [inventoryMap, setInventoryMap] = useState({}); // ndc → onHand
  useEffect(() => {
    if (!drug || !strength) { setAvailableProducts([]); setInventoryMap({}); return; }
    let cancelled = false;

    // NDC lookup result: product already known, expose it directly
    if (drug._fromNdc && drug._product) {
      setAvailableProducts([drug._product]);
      const ndcs = [drug._product.ndc].filter(Boolean);
      if (ndcs.length) {
        Promise.resolve(data.getInventoryBatch(ndcs)).then(records => {
          if (!cancelled) { const map = {}; (records || []).forEach(r => { map[r.ndcCode] = r.onHand; }); setInventoryMap(map); }
        }).catch(() => { if (!cancelled) setInventoryMap({}); });
      }
      return () => { cancelled = true; };
    }

    const result = data.getProductsForDrug(drug.id, strength);
    // Filter by form using word-prefix matching so "TAB" matches "tablet" and vice versa
    const applyFilter = (list) => {
      if (!extractedForm) return list;
      const efWords = extractedForm.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3);
      if (!efWords.length) return list;
      return list.filter(p => {
        const pf = (p.form || '').toLowerCase();
        if (!pf) return true;
        const pfWords = pf.split(/[^a-z]+/).filter(w => w.length >= 3);
        return efWords.some(ew => pfWords.some(pw => ew.startsWith(pw) || pw.startsWith(ew)));
      });
    };
    const loadInventory = async (products) => {
      if (cancelled) return;
      setAvailableProducts(products);
      if (!products.length) { setInventoryMap({}); return; }
      try {
        const ndcs = products.map(p => p.ndc).filter(Boolean);
        const records = await Promise.resolve(data.getInventoryBatch(ndcs));
        if (!cancelled) {
          const map = {};
          (records || []).forEach(r => { map[r.ndcCode] = r.onHand; });
          setInventoryMap(map);
        }
      } catch (_) { if (!cancelled) setInventoryMap({}); }
    };
    const promise = typeof result?.then === 'function' ? result : Promise.resolve(result);
    promise.then(products => loadInventory(applyFilter(products || [])));
    return () => { cancelled = true; };
  }, [drug, strength, extractedForm, data]);

  // Clear product when drug or strength changes (product no longer valid)
  useEffect(() => {
    if (product && (!drug || product.drugId !== drug.id || product.strength !== strength)) {
      setProduct(null);
    }
  }, [drug, strength]);

  const validations = useMemo(() => {
    const v = {};

    // Refill limit check
    if (drug && refills !== "") {
      const limit = data.getRefillLimit(drug.schedule);
      const r = parseInt(refills, 10);
      if (!isNaN(r)) {
        if (drug.schedule === "C-II" && r > 0) {
          v.refills = { level: "warn", msg: "Schedule II — no refills allowed" };
        } else if (r > limit) {
          v.refills = { level: "warn", msg: `Max ${limit} refills for ${data.getScheduleLabel(drug.schedule)}` };
        }
      }
    }

    // Day supply math check
    if (qty && daySupply && sig) {
      const q = parseInt(qty, 10);
      const ds = parseInt(daySupply, 10);
      if (q > 0 && ds > 0) {
        const sigLower = sig.toLowerCase();
        let perDay = 1;
        if (sigLower.includes("twice") || sigLower.includes("bid") || sigLower.includes("2 times") || sigLower.includes("two times")) perDay = 2;
        else if (sigLower.includes("three times") || sigLower.includes("tid") || sigLower.includes("3 times")) perDay = 3;
        else if (sigLower.includes("four times") || sigLower.includes("qid") || sigLower.includes("4 times")) perDay = 4;
        else if (sigLower.includes("every 4 hours") || sigLower.includes("q4h")) perDay = 6;
        else if (sigLower.includes("every 6 hours") || sigLower.includes("q6h")) perDay = 4;
        else if (sigLower.includes("every 8 hours") || sigLower.includes("q8h")) perDay = 3;
        else if (sigLower.includes("every 12 hours") || sigLower.includes("q12h")) perDay = 2;

        const expectedDays = Math.floor(q / perDay);
        if (Math.abs(expectedDays - ds) > 3) {
          v.daySupply = { level: "warn", msg: `Qty ${q} ÷ ${perDay}/day = ~${expectedDays}d (entered ${ds}d)` };
        }
      }
    }

    // Qty check
    if (qty !== "" && (isNaN(parseInt(qty, 10)) || parseInt(qty, 10) <= 0)) {
      v.qty = { level: "warn", msg: "Qty should be a positive number" };
    }

    return v;
  }, [drug, qty, daySupply, refills, sig, data]);

  // Auto-populate strength when drug changes (but not on initial e-order load or multi-field search)
  const eorderStrengthApplied = useRef(false);
  const skipNextStrengthReset = useRef(false);
  useEffect(() => {
    if (drug) {
      // If we have an e-order drug match and haven't applied it yet, skip resetting
      if (resolved?.drug && !eorderStrengthApplied.current) {
        eorderStrengthApplied.current = true;
        return;
      }
      // If multi-field search already set the strength, skip
      if (skipNextStrengthReset.current) {
        skipNextStrengthReset.current = false;
        return;
      }
      setStrength(drug.strengths[0] || "");
    } else {
      setStrength("");
    }
  }, [drug]);

  // Gate on rxState.id so submit can't fire before the DB record exists
  const canSubmit = drug && prescriber && product && qty && daySupply && sig && strength
    && canDo("SUBMIT_RX") && rxState?.id && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const techEntryData = {
      drugId: drug.id, drugName: drug.name, drugBrands: drug.brandNames,
      strength, form: product.form || drug.form, schedule: drug.schedule,
      productId: product.id, productNdc: product.ndc,
      productManufacturer: product.manufacturer, productPackSize: product.packSize,
      productIsGeneric: product.isGeneric, productDescription: product.description,
      prescriberId: prescriber.id,
      prescriberName: `Dr. ${prescriber.lastName}, ${prescriber.firstName}`,
      prescriberCredentials: prescriber.credentials,
      prescriberDEA: prescriber.dea,
      qty: parseInt(qty, 10), daySupply: parseInt(daySupply, 10),
      refills: parseInt(refills, 10) || 0, daw, sig,
      originalRxText: origRxText,
    };
    const isResubmit = rxState?.status === "returned";
    const rxAction = isResubmit ? "RESUBMIT_RX" : "SUBMIT_RX";
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await data.transitionRx(rxState.id, rxAction, currentUser.id, currentUser.role, JSON.stringify(techEntryData));
      dispatch({ type: rxAction, workspaceId: workspace.id, techEntryData, eOrder: eOrder || null, transitionResult: result });
      syncRxToStore(rxState.id, data, storeDispatch);
      // Mark the source eorder resolved on first submit so it clears from the
      // incoming queue. Not called on resubmit — it was already resolved.
      if (!isResubmit && eOrder?.id) {
        data.markEOrderResolved(eOrder.id).catch(() => {});
      }
    } catch (e) {
      setSubmitError(e?.message || "Submission failed — try again");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    dispatch({ type: "RESET_RX", workspaceId: workspace.id });
    setDrug(null); setStrength(""); setProduct(null); setPrescriber(null);
    setQty(""); setDaySupply(""); setRefills("");
    setDaw(0); setSig(""); setOrigRxText("");
    setShowOriginal(false); setShowRawFields(false);
    setInitialized(false);
  };

  // Field styling helpers
  const fieldLabel = (text, required) => (
    <label style={{
      display: "block", fontSize: 10, fontWeight: 600,
      color: T.textSecondary, textTransform: "uppercase", letterSpacing: 1,
      marginBottom: 4, fontFamily: T.mono,
    }}>
      {text}{required && <span style={{ color: "#e45858", marginLeft: 2 }}>*</span>}
    </label>
  );

  const fieldInput = (props) => ({
    style: {
      width: "100%", padding: "8px 12px", borderRadius: T.radiusSm,
      border: `1px solid ${T.inputBorder}`, background: T.inputBg,
      color: T.inputText, fontSize: 14, fontFamily: T.sans,
      outline: "none", boxSizing: "border-box", minHeight: 38,
      transition: "border-color 0.15s",
      ...props?.style,
    },
    onFocus: (e) => { e.target.style.borderColor = color.bg + "60"; },
    onBlur: (e) => { e.target.style.borderColor = T.inputBorder; },
  });

  const validationBadge = (key) => {
    const v = validations[key];
    if (!v) return null;
    return (
      <div style={{
        fontSize: 11, marginTop: 3, padding: "3px 8px", borderRadius: T.radiusXs,
        background: T.surface,
        color: T.textSecondary,
        border: `1px solid ${T.surfaceBorder}`,
        fontFamily: T.mono,
      }}>
        {v.msg}
      </div>
    );
  };

  // ── Status-gated rendering ──
  // If Rx has been submitted (techEntryData exists) and is in a post-entry status, show read-only
  if (rxState?.techEntryData && rxState.status !== "returned") {
    const statusConfig = {
      pending_review: { color: T.textSecondary, bg: T.surface, border: T.surfaceBorder, icon: "", label: "Awaiting Pharmacist Verification" },
      approved: { color: T.textSecondary, bg: T.surface, border: T.surfaceBorder, icon: "", label: "Approved — Ready to Fill" },
      in_fill: { color: T.textSecondary, bg: T.surface, border: T.surfaceBorder, icon: "", label: "Being Filled" },
      pending_fill_verify: { color: T.textSecondary, bg: T.surface, border: T.surfaceBorder, icon: "", label: "Awaiting Fill Verification" },
      ready: { color: "#4abe6a", bg: "#162018", border: "#1a3d22", icon: "", label: "Ready for Pickup" },
      call_prescriber: { color: "#e45858", bg: "#1f1418", border: "#3d2228", icon: "", label: "Call Prescriber Required" },
    };
    const sc = statusConfig[rxState.status] || statusConfig.pending_review;
    const te = rxState.techEntryData;

    return (
      <div style={{ padding: 16, fontFamily: T.sans, fontSize: 14, color: T.textPrimary }}>
        {/* Status banner */}
        <div style={{
          padding: "12px 16px", borderRadius: 8, marginBottom: 12,
          background: sc.bg, border: `1.5px solid ${sc.border}`,
          display: "flex", alignItems: "center", gap: 10,
          fontFamily: T.mono,
        }}>
          
          <div>
            <div style={{ fontWeight: 800, color: sc.color, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
              {sc.label}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
              {rxState.rxNumber ? `Rx# ${rxState.rxNumber} · ` : ""}Submitted {new Date(rxState.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        </div>

        {/* Pharmacist notes (if returned or has review) */}
        {rxState.rphReviewData?.notes && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, marginBottom: 12,
            background: T.surface, border: `1px solid ${T.surfaceBorder}`,
            fontSize: 12, color: T.textSecondary, lineHeight: 1.5,
          }}>
            <strong style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Pharmacist Notes:</strong>
            <div style={{ marginTop: 4 }}>{rxState.rphReviewData.notes}</div>
          </div>
        )}

        {/* Read-only entry summary */}
        <div style={{
          padding: 14, borderRadius: 8, background: T.surface, border: `1px solid ${T.surfaceBorder}`,
          fontFamily: T.mono, fontSize: 12, lineHeight: 1.8,
          opacity: 0.85,
        }}>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Drug</span><strong>{te.drugName} {te.strength}</strong></div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Product</span>{te.productNdc} <span style={{ color: T.textSecondary, marginLeft: 4 }}>{te.productManufacturer} · {te.productPackSize}ct</span></div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>SIG</span>{te.sig}</div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Qty</span>{te.qty} <span style={{ color: T.textSecondary, marginLeft: 8 }}>Day supply: {te.daySupply}</span> <span style={{ color: T.textSecondary, marginLeft: 8 }}>Refills: {te.refills}</span></div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Prescriber</span>{te.prescriberName}, {te.prescriberCredentials}</div>
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>DAW</span>{te.daw}</div>
        </div>

        {/* Original e-script for reference */}
        {rxState.eOrder && (
          <div style={{ marginTop: 12 }}>
            <EScriptPanel eOrder={rxState.eOrder} defaultOpen={false} />
          </div>
        )}

        {rxState.status === "approved" && (
          <button onClick={handleReset} style={{
            marginTop: 12, width: "100%", padding: "10px 16px", borderRadius: 8,
            border: "none", cursor: "pointer",
            background: `linear-gradient(135deg, ${color.bg}, ${color.bg}dd)`,
            color: "#fff", fontSize: 13, fontWeight: 800, textTransform: "uppercase",
            letterSpacing: 1, fontFamily: T.mono,
          }}>New Rx</button>
        )}
      </div>
    );
  }

  // If returned, the form is editable again — pre-populate from the returned techEntry
  // (The normal form renders below with existing state)

  return (
    <div style={{ padding: 16, fontFamily: T.sans, fontSize: 14, color: T.textPrimary }}>
      {/* ── Allergy Banner ── */}
      {patient.allergies?.length > 0 && (
        <div style={{
          padding: "8px 12px", borderRadius: 8, marginBottom: 12,
          background: "#1f1418", border: "1px solid #3d2228",
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 12, color: "#e45858", fontWeight: 700,
          fontFamily: T.mono,
        }}>
          
          <span>ALLERGIES: {patient.allergies.join(" · ")}</span>
        </div>
      )}

      {/* ── Drug Schedule Badge ── */}
      {drug && ["C-II", "C-III", "C-IV", "C-V"].includes(drug.schedule) && (
        <div style={{
          padding: "6px 12px", borderRadius: 8, marginBottom: 12,
          background: "#1f1a14", border: "1px solid #3d3020",
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 12, color: "#e8a030", fontWeight: 700,
          fontFamily: T.mono,
        }}>
          
          <span>CONTROLLED: {data.getScheduleLabel(drug.schedule)}</span>
          {drug.schedule === "C-II" && <span style={{ fontWeight: 400, marginLeft: 4 }}>— No refills, written Rx required</span>}
        </div>
      )}

      {/* ── E-Order Reference (two layers) ── */}
      {eOrder ? (
        <div style={{ marginBottom: 12 }}>
          {/* Layer 1: Human-readable transcription — always visible */}
          <div style={{
            padding: "12px 14px", borderRadius: 8,
            background: T.surface, border: `1px solid ${T.surfaceBorder}`,
            fontFamily: T.mono, fontSize: 12, lineHeight: 1.7,
          }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
                E-Script — {eOrder.messageId}
              </span>
              <span style={{ fontSize: 10, color: T.textMuted }}>
                {new Date(eOrder.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "3px 10px" }}>
              <span style={{ color: T.textMuted, fontWeight: 600 }}>Drug</span>
              <span style={{ fontWeight: 700, color: T.textPrimary }}>{eOrder.transcribed.drug}</span>
              <span style={{ color: T.textMuted, fontWeight: 600 }}>SIG</span>
              <span>{eOrder.transcribed.sig}</span>
              <span style={{ color: T.textMuted, fontWeight: 600 }}>Qty</span>
              <span>{eOrder.transcribed.qty}
                <span style={{ color: T.textMuted, marginLeft: 10 }}>Day supply: {eOrder.transcribed.daySupply}</span>
                <span style={{ color: T.textMuted, marginLeft: 10 }}>Refills: {eOrder.transcribed.refills}</span>
              </span>
              <span style={{ color: T.textMuted, fontWeight: 600 }}>Prescriber</span>
              <span>{eOrder.transcribed.prescriber}
                <span style={{ color: T.textMuted, marginLeft: 8 }}>DEA: {eOrder.transcribed.prescriberDEA}</span>
              </span>
              <span style={{ color: T.textMuted, fontWeight: 600 }}>Written</span>
              <span>{eOrder.transcribed.dateWritten}</span>
            </div>
            {eOrder.transcribed.note && (
              <div style={{ marginTop: 6, padding: "5px 8px", borderRadius: 4, background: T.surface, color: T.textSecondary, fontSize: 11 }}>
                <strong>Note:</strong> {eOrder.transcribed.note}
              </div>
            )}

            {/* Drug match confidence indicator */}
            {resolved && (
              <div style={{ marginTop: 8, display: "flex", gap: 10, fontSize: 10, fontWeight: 600 }}>
                {resolved.drug ? (
                  <span style={{
                    padding: "2px 8px", borderRadius: 3,
                    background: T.surface, color: T.textMuted,
                    border: `1px solid ${T.surfaceBorder}`,
                  }}>
                    Drug match: {resolved.drug.confidence} → {resolved.drug.drug.name} {resolved.drug.strength}
                  </span>
                ) : (
                  <span style={{ padding: "2px 8px", borderRadius: 3, background: T.surface, color: T.textSecondary, border: `1px solid ${T.surfaceBorder}` }}>
                    Drug: no auto-match — manual selection needed
                  </span>
                )}
                {resolved.prescriber ? (
                  <span style={{
                    padding: "2px 8px", borderRadius: 3,
                    background: T.surface, color: T.textMuted,
                    border: `1px solid ${T.surfaceBorder}`,
                  }}>
                    Prescriber match: {resolved.prescriber.confidence}
                  </span>
                ) : (
                  <span style={{ padding: "2px 8px", borderRadius: 3, background: T.surface, color: T.textSecondary, border: `1px solid ${T.surfaceBorder}` }}>
                    Prescriber: no auto-match
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Layer 2: Raw fielded data — collapsible */}
          <button
            onClick={() => setShowRawFields(!showRawFields)}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%",
              padding: "5px 10px", marginTop: 4, borderRadius: showRawFields ? "0" : "0 0 6px 6px",
              border: `1px solid ${T.surfaceBorder}`, borderTop: "none", background: T.surface,
              cursor: "pointer", fontSize: 10, color: T.textMuted,
              fontFamily: T.mono, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: 0.5,
            }}
          >
            <span style={{ transform: showRawFields ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s", display: "inline-block" }}>▸</span>
            Raw NCPDP Fields
          </button>
          {showRawFields && (
            <div style={{
              padding: "10px 12px", background: T.surface, border: `1px solid ${T.surfaceBorder}`,
              borderTop: "none", borderRadius: "0 0 6px 6px",
              fontFamily: T.mono, fontSize: 11, lineHeight: 1.6,
              maxHeight: 200, overflowY: "auto", color: T.textSecondary,
            }}>
              {Object.entries(eOrder.raw).map(([key, value]) => (
                <div key={key} style={{ display: "flex", gap: 8, borderBottom: "1px solid #e2e8f020", padding: "2px 0" }}>
                  <span style={{ color: T.textSecondary, minWidth: 160, flexShrink: 0, fontWeight: 600 }}>{key}</span>
                  <span style={{ color: T.textPrimary, wordBreak: "break-all" }}>{value || "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* No e-order — manual entry, show the original Rx text area */
        <>
          <button
            onClick={() => setShowOriginal(!showOriginal)}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%",
              padding: "6px 10px", borderRadius: 6, marginBottom: showOriginal ? 0 : 12,
              border: `1px solid ${T.surfaceBorder}`, background: T.surface, cursor: "pointer",
              fontSize: 11, color: T.textMuted, fontFamily: T.mono,
              fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5,
            }}
          >
            <span style={{ transform: showOriginal ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s", display: "inline-block" }}>▸</span>
            Original Rx / Ground Truth
          </button>
          {showOriginal && (
            <div style={{ marginBottom: 12 }}>
              <textarea
                value={origRxText}
                onChange={(e) => setOrigRxText(e.target.value)}
                placeholder="Paste or type the original prescription text here (e-script, fax, verbal order notes)..."
                rows={3}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: "0 0 6px 6px",
                  border: `1px solid ${T.surfaceBorder}`, borderTop: "none", background: T.surface,
                  color: T.textPrimary, fontSize: 12, fontFamily: T.mono,
                  outline: "none", resize: "vertical", boxSizing: "border-box", lineHeight: 1.5,
                }}
              />
            </div>
          )}
        </>
      )}

      {/* ── Drug + Strength + Form row ── */}
      <div style={{ display: "grid", gridTemplateColumns: drug ? "1fr auto auto" : "1fr", gap: 10, marginBottom: 10, alignItems: "start" }}>
        <div>
          {fieldLabel("Drug", true)}
          <DrugSearch
            onSearch={searchDrugOrNdc}
            onSelect={(d) => {
              if (!d) { setDrug(null); return; }
              if (d._matchedStrength) {
                skipNextStrengthReset.current = true;
                setStrength(d._matchedStrength);
              }
              setDrug(d);
              if (d.id) storeDispatch({ type: 'ENTITY_UPDATED', entityType: 'drug', entityId: d.id, data: d });
              if (d._product) setProduct(d._product);
            }}
            selected={drug}
            color={color}
            autoFocus
            renderItem={(d, hl) => d._fromNdc ? (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.textPrimary }}>{d.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#40c0b0", background: "#40c0b018", border: "1px solid #40c0b030", padding: "0 5px", borderRadius: 3, marginLeft: 6 }}>NDC</span>
                  <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 1, fontFamily: T.mono }}>{d._ndc}</div>
                  <div style={{ fontSize: 11, color: T.textMuted }}>{d.drugClass}</div>
                </div>
                <span style={{ fontWeight: 700, fontSize: 12, color: "#40c0b0" }}>{d._matchedStrength}</span>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.textPrimary }}>{d.name}</span>
                  {d.brandNames?.[0] && <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 6 }}>({d.brandNames[0]})</span>}
                  {d._matchedStrength && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#5b8af5", marginLeft: 6, background: "#141a24", padding: "0 5px", borderRadius: 3 }}>
                      {d._matchedStrength}
                    </span>
                  )}
                  <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 1 }}>
                    {d.drugClass}<span style={{ color: "#cbd5e1", margin: "0 4px" }}>·</span>{d.form}
                  </div>
                </div>
                {["C-II", "C-III", "C-IV", "C-V"].includes(d.schedule) && (
                  <span style={{ fontSize: 10, fontWeight: 800, color: "#e8a030", background: "#1f1a14", border: "1px solid #3d3020", padding: "1px 6px", borderRadius: 3, fontFamily: T.mono }}>
                    {d.schedule}
                  </span>
                )}
              </div>
            )}
            renderSelected={(d) => (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>{d.name}</span>
                {d.brandNames?.[0] && <span style={{ fontSize: 11, color: T.textMuted }}>({d.brandNames[0]})</span>}
                {["C-II", "C-III", "C-IV", "C-V"].includes(d.schedule) && (
                  <span style={{ fontSize: 9, fontWeight: 800, color: "#e8a030", background: "#1f1a14", border: "1px solid #3d3020", padding: "0 4px", borderRadius: 2 }}>{d.schedule}</span>
                )}
              </div>
            )}
          />
        </div>

        {/* Strength + Form (same row as drug when drug is selected) */}
        {drug && (
          <div style={{ minWidth: 100 }}>
            {fieldLabel("Strength", true)}
            <select
              value={strength}
              onChange={(e) => setStrength(e.target.value)}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: T.radiusSm,
                border: `1px solid ${T.inputBorder}`, background: T.inputBg,
                color: strength ? T.textPrimary : T.textMuted, fontSize: 14, fontFamily: T.sans,
                outline: "none", boxSizing: "border-box", minHeight: 38, cursor: "pointer",
                appearance: "none",
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%235a6475'%3E%3Cpath d='M5 7L1 3h8z'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center",
                paddingRight: 28,
              }}
            >
              <option value="" disabled>Select</option>
              {drug.strengths.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {drug && (
          <div style={{ minWidth: 90 }}>
            {fieldLabel("Form", false)}
            <input
              value={product?.form || extractedForm || drug.form}
              readOnly
              {...fieldInput({ style: { background: T.surface, color: T.textMuted } })}
            />
          </div>
        )}
      </div>

      {/* ── Product Selection ── */}
      {drug && strength && (
        <div style={{ marginBottom: 10 }}>
          {fieldLabel("Product (NDC)", true)}
          {product ? (
            <div
              tabIndex={0}
              onClick={() => setProduct(null)}
              onKeyDown={(e) => {
                if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); setProduct(null); }
              }}
              style={{
                width: "100%", padding: "7px 10px", borderRadius: 6,
                border: `1.5px solid ${color.border}60`, background: color.light,
                fontSize: 12, fontFamily: T.mono,
                display: "flex", alignItems: "center", justifyContent: "space-between",
                cursor: "pointer", color: T.textPrimary, minHeight: 36, boxSizing: "border-box",
                outline: "none",
              }}
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700 }}>{product.ndc}</span>
                <span style={{ color: T.textMuted, marginLeft: 8 }}>{product.manufacturer}</span>
                <span style={{ color: T.textSecondary, marginLeft: 8 }}>{product.packSize}ct</span>
                {!product.isGeneric && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: T.textMuted, background: T.surface, border: `1px solid ${T.surfaceBorder}`, padding: "0 4px", borderRadius: 2, marginLeft: 6 }}>BRAND</span>
                )}
              </div>
              <span onClick={(e) => { e.stopPropagation(); setProduct(null); }} style={{ color: T.textSecondary, cursor: "pointer", fontSize: 14, padding: "0 2px", marginLeft: 8 }}>×</span>
            </div>
          ) : (
            <div style={{
              border: `1px solid ${T.inputBorder}`, borderRadius: 6, background: T.surfaceRaised,
              maxHeight: 140, overflowY: "auto",
            }}>
              {availableProducts.length > 0 ? availableProducts.map(p => (
                <div key={p.id} onClick={() => setProduct(p)}
                  style={{
                    padding: "6px 10px", cursor: "pointer", fontSize: 12,
                    fontFamily: T.mono,
                    borderBottom: `1px solid ${T.surfaceBorder}`,
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    transition: "background 0.1s",
                  }}
                  onMouseOver={(e) => e.currentTarget.style.background = color.light}
                  onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 800, color: T.textPrimary, letterSpacing: "0.5px" }}>{p.ndc}</span>
                    <span style={{ color: T.textSecondary }}>{p.manufacturer}</span>
                    {!p.isGeneric && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: T.textMuted, background: T.surface, border: `1px solid ${T.surfaceBorder}`, padding: "0 4px", borderRadius: 2 }}>BRAND</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {(() => {
                      const oh = inventoryMap[p.ndc];
                      if (oh == null) return null;
                      const low = oh <= 20;
                      return (
                        <span style={{
                          fontSize: 10, fontWeight: 700, fontFamily: T.mono,
                          color: low ? "#e8a030" : "#4abe6a",
                          background: low ? "#1f1a14" : "#162018",
                          border: `1px solid ${low ? "#3d3020" : "#1a3d22"}`,
                          padding: "1px 6px", borderRadius: 3,
                        }}>
                          {oh} on hand
                        </span>
                      );
                    })()}
                    <span style={{ color: T.textMuted, fontSize: 11 }}>
                      {p.packSize > 0 ? `${p.packSize}ct` : ''}
                    </span>
                  </div>
                </div>
              )) : (
                <div style={{ padding: "10px 12px", color: T.textSecondary, fontSize: 12, fontStyle: "italic", textAlign: "center" }}>
                  No products on file for {drug.name} {strength}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Qty / Day Supply / Refills row ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          {fieldLabel("Qty", true)}
          <input
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder=""
            {...fieldInput()}
            onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
            onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
          />
          {validationBadge("qty")}
        </div>
        <div>
          {fieldLabel("Day Supply", true)}
          <input
            type="number"
            min="1"
            value={daySupply}
            onChange={(e) => setDaySupply(e.target.value)}
            placeholder=""
            {...fieldInput()}
            onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
            onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
          />
          {validationBadge("daySupply")}
        </div>
        <div>
          {fieldLabel("Refills", false)}
          <input
            type="number"
            min="0"
            value={refills}
            onChange={(e) => setRefills(e.target.value)}
            placeholder=""
            {...fieldInput()}
            onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
            onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
          />
          {validationBadge("refills")}
        </div>
      </div>

      {/* ── SIG ── */}
      <div style={{ marginBottom: 10 }}>
        {fieldLabel("SIG (Directions)", true)}
        <textarea
          value={sig}
          onChange={(e) => setSig(e.target.value)}
          placeholder="Type prescription instructions here..."
          rows={2}
          style={{
            width: "100%", padding: "7px 10px", borderRadius: 6,
            border: `1px solid ${T.inputBorder}`, background: T.surfaceRaised,
            color: T.textPrimary, fontSize: 13, fontFamily: T.mono,
            outline: "none", boxSizing: "border-box", resize: "vertical",
            lineHeight: 1.5, minHeight: 36, transition: "border-color 0.15s",
          }}
          onFocus={(e) => { e.target.style.borderColor = color.bg + "80"; }}
          onBlur={(e) => { e.target.style.borderColor = "#cbd5e1"; }}
        />
      </div>

      {/* ── DAW ── */}
      <div style={{ marginBottom: 14 }}>
        {fieldLabel("DAW Code", false)}
        <select
          value={daw}
          onChange={(e) => setDaw(parseInt(e.target.value, 10))}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: T.radiusSm,
            border: `1px solid ${T.inputBorder}`, background: T.inputBg,
            color: T.textPrimary, fontSize: 14, fontFamily: T.sans,
            outline: "none", boxSizing: "border-box", minHeight: 38, cursor: "pointer",
            appearance: "none",
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%235a6475'%3E%3Cpath d='M5 7L1 3h8z'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center",
            paddingRight: 28,
          }}
        >
          {DAW_CODES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>

      {/* ── Prescriber Search ── */}
      <div style={{ marginBottom: 10 }}>
        {fieldLabel("Prescriber", true)}
        <InlineSearch
          placeholder="Search by name, DEA, NPI..."
          onSearch={searchPrescribers}
          onSelect={setPrescriber}
          selected={prescriber}
          color={color}
          renderItem={(p, hl) => (
            <div>
              <span style={{ fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.textPrimary }}>
                Dr. {p.lastName}, {p.firstName}
              </span>
              <span style={{ fontSize: 11, color: T.textSecondary, marginLeft: 6 }}>{p.credentials}</span>
              <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 1 }}>
                {p.practice} · DEA: {p.dea}
              </div>
            </div>
          )}
          renderSelected={(p) => (
            <span>
              <span style={{ fontWeight: 700 }}>Dr. {p.lastName}, {p.firstName}</span>
              <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 6 }}>{p.credentials} · {p.practice}</span>
            </span>
          )}
        />
      </div>

      {/* ── Submit ── */}
      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: 8,
          border: "none", cursor: canSubmit ? "pointer" : "not-allowed",
          background: canSubmit ? color.bg : T.surface,
          color: canSubmit ? "#fff" : T.textMuted,
          fontSize: 13, fontWeight: 800, textTransform: "uppercase",
          letterSpacing: 1, fontFamily: T.mono,
          transition: "all 0.2s",
          boxShadow: canSubmit ? `0 4px 12px ${color.bg}40` : "none",
        }}
      >
        {submitting ? "Submitting…" : "Submit Rx Entry"}
      </button>
      {submitError && (
        <div style={{ marginTop: 8, padding: "6px 12px", borderRadius: 6, background: "#1f1418", border: "1px solid #3d2228", color: "#e45858", fontSize: 11, fontFamily: T.mono }}>
          {submitError}
        </div>
      )}
    </div>
  );
}


// ============================================================
// PHARMACIST VERIFICATION COMPONENT
// ============================================================
function RphVerifyContent({ patient, workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo, currentUser } = useContext(PharmIDEContext);
  const { storeDispatch, getEntity, getPrescriberById } = useData();
  const color = workspace.color;
  const rxStateWs = workspace.rxPrescription;
  const storeRx = rxStateWs?.id ? getEntity('prescription', rxStateWs.id) : null;
  // Merge: workspace is authoritative for status/rxNumber (state machine drives these),
  // but fall back to store for data fields that INIT_PRESCRIPTION initialises to null.
  const rxState = rxStateWs ? {
    ...rxStateWs,
    techEntryData: rxStateWs.techEntryData ?? storeRx?.techEntryData ?? null,
    rphReviewData: rxStateWs.rphReviewData ?? storeRx?.rphReviewData ?? null,
    eOrder: rxStateWs.eOrder ?? storeRx?.eOrder ?? null,
  } : null;

  const [checkedFields, setCheckedFields] = useState({});
  const [notes, setNotes] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState(null);

  // No Rx to verify, or still in entry (techEntryData not populated yet)
  if (!rxState || !rxState.techEntryData) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: T.textSecondary, fontFamily: T.mono, fontSize: 13 }}>
        <div style={{ fontWeight: 600 }}>No prescription pending verification</div>
        <div style={{ fontSize: 12, marginTop: 6, opacity: 0.6 }}>Submit an Rx from the Rx Entry tab first.</div>
      </div>
    );
  }

  // Already decided
  if (rxState.status === "approved" || rxState.status === "returned" || rxState.status === "call_prescriber") {
    const sc = {
      approved: { icon: "", label: "Approved", color: "#4abe6a", bg: "#162018", border: "#1a3d22" },
      returned: { icon: "", label: "Returned to Tech", color: "#e8a030", bg: "#1f1a14", border: "#3d3020" },
      call_prescriber: { icon: "", label: "Call Prescriber", color: "#e45858", bg: "#1f1418", border: "#3d2228" },
    }[rxState.status];
    return (
      <div style={{ padding: 16, fontFamily: T.sans, fontSize: 14, color: T.textPrimary }}>
        <div style={{
          padding: "16px 20px", borderRadius: 8, background: sc.bg, border: `1.5px solid ${sc.border}`,
          textAlign: "center",
        }}>
          
          <div style={{ fontWeight: 800, color: sc.color, fontSize: 14, textTransform: "uppercase", letterSpacing: 1 }}>
            {sc.label}
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{rxState.rxNumber ? `Rx# ${rxState.rxNumber}` : ""}</div>
          {rxState.rphReviewData?.notes && (
            <div style={{ marginTop: 10, fontSize: 12, color: T.textSecondary, textAlign: "left", padding: "8px 12px", background: T.surfaceRaised, borderRadius: 6, border: `1px solid ${T.surfaceBorder}` }}>
              <strong>Notes:</strong> {rxState.rphReviewData.notes}
            </div>
          )}
        </div>
      </div>
    );
  }

  const te = rxState.techEntryData;
  const eOrder = rxState.eOrder;
  const orig = eOrder?.transcribed || {};

  // Field comparison data
  const fields = [
    { key: "drug", label: "Drug", original: orig.drug || "—", entered: `${te.drugName} ${te.strength}` },
    { key: "product", label: "Product / NDC", original: orig.drugNDC || "—", entered: `${te.productNdc} (${te.productManufacturer} ${te.productPackSize}ct)` },
    { key: "sig", label: "SIG", original: orig.sig || "—", entered: te.sig },
    { key: "qty", label: "Quantity", original: orig.qty != null ? String(orig.qty) : "—", entered: String(te.qty) },
    { key: "daySupply", label: "Day Supply", original: orig.daySupply != null ? String(orig.daySupply) : "—", entered: String(te.daySupply) },
    { key: "refills", label: "Refills", original: orig.refills != null ? String(orig.refills) : "—", entered: String(te.refills) },
    { key: "daw", label: "DAW", original: orig.daw != null ? String(orig.daw) : "—", entered: String(te.daw) },
    { key: "prescriber", label: "Prescriber", original: `${orig.prescriber || "—"}\nDEA: ${orig.prescriberDEA || "—"}`, entered: `${te.prescriberName}, ${te.prescriberCredentials}\nDEA: ${te.prescriberDEA}` },
  ];

  const toggleField = (key) => {
    setCheckedFields(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const allChecked = fields.every(f => checkedFields[f.key]);
  const checkedCount = fields.filter(f => checkedFields[f.key]).length;

  const handleDecision = async (decision) => {
    if (deciding) return;
    const actionMap = { approve: "RPH_APPROVE", return: "RPH_RETURN", call_prescriber: "RPH_CALL" };
    const rxAction = actionMap[decision];
    const checkedList = Object.keys(checkedFields).filter(k => checkedFields[k]);
    setDeciding(true);
    setDecisionError(null);
    try {
      const result = await data.transitionRx(rxState.id, rxAction, currentUser.id, currentUser.role, JSON.stringify({ notes, checkedFields: checkedList }));
      dispatch({ type: rxAction, workspaceId: workspace.id, notes, checkedFields: checkedList, transitionResult: result });
      syncRxToStore(rxState.id, data, storeDispatch);
    } catch (e) {
      setDecisionError(e?.message || "Action failed — try again");
    } finally {
      setDeciding(false);
    }
  };

  // Mismatch detection
  const detectMismatch = (field) => {
    if (!eOrder) return "none";
    const o = field.original.replace(/\s+/g, " ").trim().toLowerCase();
    const e = field.entered.replace(/\s+/g, " ").trim().toLowerCase();
    if (o === "—") return "none";
    if (["qty", "daySupply", "refills", "daw"].includes(field.key)) {
      return o === e ? "match" : "mismatch";
    }
    return (e.includes(o) || o.includes(e)) ? "match" : "mismatch";
  };

  // Desaturated accent — ~70% less vibrant, reserve bright for warnings
  const accent = T.textSecondary;
  const accentLight = T.surface;
  const accentBorder = T.surfaceBorder;

  return (
    <div style={{ padding: "16px 18px", fontFamily: T.sans, fontSize: 13 }}>
      {/* Header — desaturated */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 14, padding: "10px 14px", borderRadius: 8,
        background: accentLight, border: `1px solid ${accentBorder}`,
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 11, color: accent, textTransform: "uppercase", letterSpacing: 1, fontFamily: T.mono }}>
            Pharmacist Verification
          </div>
          <div style={{ fontSize: 11, color: "T.textSecondary", marginTop: 3, fontFamily: T.mono }}>
            {rxState.rxNumber ? `Rx# ${rxState.rxNumber} · ` : ""}{patient.name}
          </div>
        </div>
        <div style={{
          padding: "5px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700,
          fontFamily: T.mono,
          background: allChecked ? "#162018" : accentLight,
          color: allChecked ? "#16a34a" : accent,
          border: `1px solid ${allChecked ? "#1a3d22" : T.surfaceBorder}`,
        }}>
          {checkedCount}/{fields.length} verified
        </div>
      </div>

      {/* Allergy banner — FULL bright, this is a warning */}
      {patient.allergies?.length > 0 && (
        <div style={{
          padding: "9px 14px", borderRadius: 8, marginBottom: 14,
          background: "#1f1418", border: "1px solid #3d2228",
          fontSize: 12, color: "#e45858", fontWeight: 700,
          fontFamily: T.mono,
          display: "flex", alignItems: "center", gap: 8,
        }}>

          ALLERGIES: {patient.allergies.join(" · ")}
        </div>
      )}

      {/* Active meds — desaturated */}
      {patient.medications?.length > 0 && (
        <div style={{
          padding: "9px 14px", borderRadius: 8, marginBottom: 14,
          background: T.surface, border: `1px solid ${accentBorder}`,
          fontSize: 11, color: "#5a6a82", fontFamily: T.mono,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5, color: accent }}>
            Active Medications ({patient.medications?.length ?? 0})
          </div>
          {(patient.medications || []).map((m, i) => (
            <div key={i} style={{ color: T.textSecondary, padding: "2px 0" }}>
              {m.name} — {m.directions}
            </div>
          ))}
        </div>
      )}

      {/* Prescriber name-change notice */}
      {(() => {
        const prescriberId = rxState.techEntryData?.prescriberId || rxState.prescriber?.id;
        const livePrescriberData = prescriberId ? getPrescriberById(prescriberId) : null;
        const prescriberFormer = livePrescriberData?.formerLastName;
        if (!prescriberFormer) return null;
        return (
          <div style={{
            padding: "8px 12px", borderRadius: 8, marginBottom: 14,
            background: "#fef3c720", border: "1px solid #f59e0b60",
            fontSize: 12, color: "#f59e0b",
          }}>
            Name change: this prescriber was formerly Dr. {prescriberFormer}.
            {livePrescriberData.nameChangedAt ? ` Prescriptions before ${livePrescriberData.nameChangedAt.slice(0, 10)} were filed under the former name.` : ''}
          </div>
        );
      })()}

      {/* Original e-script reference */}
      {eOrder && (
        <div style={{ marginBottom: 14 }}>
          <EScriptPanel eOrder={eOrder} defaultOpen={true} />
        </div>
      )}

      {/* Comparison table — single header row */}
      <div style={{ marginBottom: 14, border: `1px solid ${accentBorder}`, borderRadius: 8, overflow: "hidden" }}>
        {/* Column header */}
        <div style={{
          display: "grid", gridTemplateColumns: "32px 100px 1fr 1fr",
          background: T.surface, borderBottom: `1px solid ${accentBorder}`,
          padding: "6px 0", fontFamily: T.mono,
          fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: "T.textSecondary",
        }}>
          <span></span>
          <span style={{ padding: "0 10px" }}>Field</span>
          <span style={{ padding: "0 10px" }}>Original</span>
          <span style={{ padding: "0 10px" }}>Entered</span>
        </div>

        {/* Rows */}
        {fields.map((field, idx) => {
          const checked = !!checkedFields[field.key];
          const status = detectMismatch(field);
          const isMatch = status === "match";
          const isMismatch = status === "mismatch";

          // Row colors: subtle dark tints + zebra stripe on neutral rows
          const zebraBase = idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.022)";
          const rowBg = checked ? T.surfaceHover
            : isMismatch ? "#1f1a14"
            : isMatch ? T.surface
            : zebraBase;
          const leftBorder = checked ? `${T.textMuted}40`
            : isMismatch ? "#e8a03060"
            : isMatch ? T.surfaceBorder
            : "transparent";

          return (
            <div
              key={field.key}
              onClick={() => toggleField(field.key)}
              style={{
                display: "grid", gridTemplateColumns: "32px 100px 1fr 1fr",
                cursor: "pointer", background: rowBg,
                borderBottom: `1px solid rgba(255,255,255,0.04)`,
                borderLeft: `3px solid ${leftBorder}`,
                transition: "all 0.12s ease", userSelect: "none",
              }}
            >
              {/* Checkbox */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 0" }}>
                <div style={{
                  width: 15, height: 15, borderRadius: 3,
                  border: `2px solid ${checked ? T.textAccent : T.surfaceBorder}`,
                  background: checked ? T.textAccent : T.inputBg,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.12s",
                }}>
                  {checked && <span style={{ color: "#fff", fontSize: 10, fontWeight: 800 }}>✓</span>}
                </div>
              </div>

              {/* Label */}
              <div style={{
                padding: "12px 10px", fontSize: 11, fontWeight: 600, color: accent,
                fontFamily: T.mono, display: "flex", alignItems: "center",
              }}>
                {field.label}
              </div>

              {/* Original */}
              <div style={{
                padding: "12px 10px", fontSize: 12, color: T.textSecondary,
                fontFamily: T.mono, whiteSpace: "pre-wrap", lineHeight: 1.5,
                borderLeft: `1px solid ${T.surfaceBorder}`,
              }}>
                {field.original}
              </div>

              {/* Entered */}
              <div style={{
                padding: "12px 10px", fontSize: 13, color: T.textPrimary, fontWeight: 500,
                fontFamily: T.mono, whiteSpace: "pre-wrap", lineHeight: 1.5,
                borderLeft: `1px solid ${T.surfaceBorder}`,
                position: "relative",
              }}>
                {field.entered}
                {isMismatch && !checked && (
                  <span style={{ fontSize: 9, color: "#e8a030", fontWeight: 700, marginLeft: 6 }}>VERIFY</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Notes — desaturated */}
      <div style={{ marginBottom: 14 }}>
        <label style={{
          display: "block", fontSize: 9, fontWeight: 700, color: accent,
          textTransform: "uppercase", letterSpacing: 1, marginBottom: 4,
          fontFamily: T.mono,
        }}>
          Pharmacist Notes
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Clinical notes, concerns, instructions for tech..."
          rows={2}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 6,
            border: `1.5px solid ${accentBorder}`, background: T.inputBg,
            color: T.textPrimary, fontSize: 12, fontFamily: T.mono,
            outline: "none", boxSizing: "border-box", resize: "vertical", lineHeight: 1.5,
          }}
          onFocus={(e) => { e.target.style.borderColor = accent + "80"; }}
          onBlur={(e) => { e.target.style.borderColor = accentBorder; }}
        />
      </div>

      {/* Decision buttons */}
      {canDo("RPH_APPROVE") ? (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <button
              onClick={() => handleDecision("approve")}
              disabled={!allChecked || deciding}
              style={{
                padding: "10px 8px", borderRadius: 6, border: "none", cursor: (allChecked && !deciding) ? "pointer" : "not-allowed",
                background: allChecked ? "#4abe6a" : T.surface,
                color: allChecked ? "#fff" : T.textMuted,
                fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
                fontFamily: T.mono, transition: "all 0.2s", opacity: deciding ? 0.6 : 1,
              }}
            >
              {deciding ? "…" : "Approve"}
            </button>
            <button
              onClick={() => handleDecision("return")}
              disabled={deciding}
              style={{
                padding: "10px 8px", borderRadius: 6, border: `1.5px solid ${accentBorder}`,
                background: accentLight, color: accent, cursor: deciding ? "not-allowed" : "pointer",
                fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
                fontFamily: T.mono, opacity: deciding ? 0.6 : 1,
              }}
            >
              Return
            </button>
            <button
              onClick={() => handleDecision("call_prescriber")}
              disabled={deciding}
              style={{
                padding: "10px 8px", borderRadius: 6, border: "1px solid #3d2228",
                background: "#1f1418", color: "#e45858", cursor: deciding ? "not-allowed" : "pointer",
                fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
                fontFamily: T.mono, opacity: deciding ? 0.6 : 1,
              }}
            >
              Call Dr.
            </button>
          </div>
          {decisionError && (
            <div style={{ marginTop: 8, padding: "6px 12px", borderRadius: 6, background: "#1f1418", border: "1px solid #3d2228", color: "#e45858", fontSize: 11, fontFamily: T.mono }}>
              {decisionError}
            </div>
          )}
        </div>
      ) : (
        <div style={{
          padding: "12px 16px", borderRadius: 8, background: T.surface,
          color: "T.textSecondary", fontSize: 12, textAlign: "center",
          fontFamily: T.mono, fontStyle: "italic",
        }}>
          Pharmacist verification required — tech view only
        </div>
      )}
    </div>
  );
}


// ============================================================
// FILL — Tech fills the prescription
// ============================================================
function FillContent({ patient, workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo, currentUser } = useContext(PharmIDEContext);
  const { storeDispatch, getEntity } = useData();
  const color = workspace.color;
  const rxStateWs = workspace.rxPrescription;
  const storeRx = rxStateWs?.id ? getEntity('prescription', rxStateWs.id) : null;
  const rxState = rxStateWs ? {
    ...rxStateWs,
    techEntryData: rxStateWs.techEntryData ?? storeRx?.techEntryData ?? null,
  } : null;

  const [scannedNdc, setScannedNdc] = useState("");
  const [scanResult, setScanResult] = useState(null); // null | "match" | "mismatch"
  const [confirmedQty, setConfirmedQty] = useState("");
  const [scanInput, setScanInput] = useState(null);
  const [fillError, setFillError] = useState(null);

  // Focus scan input on mount
  useEffect(() => {
    if (scanInput) scanInput.focus();
  }, [scanInput]);

  // ── Not ready to fill ──
  if (!rxState || (rxState.status !== "approved" && rxState.status !== "in_fill" && rxState.status !== "pending_fill_verify" && rxState.status !== "ready")) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: T.textMuted, fontFamily: T.mono }}>
        
        <div style={{ fontSize: 13 }}>
          {!rxState ? "No prescription entered yet" :
            rxState.status === "pending_review" ? "Awaiting pharmacist verification" :
              rxState.status === "returned" ? "Rx returned — needs correction" :
                rxState.status === "call_prescriber" ? "Awaiting prescriber callback" :
                  "Not ready to fill"}
        </div>
      </div>
    );
  }

  const te = rxState.techEntryData;
  const drug = data.getDrug(te.drugId);
  const expectedNdc = te.productNdc || "UNKNOWN";
  const isControl = te.schedule?.startsWith("C-");
  const needsQtyConfirm = isControl;

  // ── Start fill (transition from approved → in_fill) ──
  const handleStartFill = async () => {
    if (!canDo("START_FILL") || !rxState?.id) return;
    setFillError(null);
    try {
      const result = await data.transitionRx(rxState.id, "START_FILL", currentUser.id, currentUser.role, "{}");
      dispatch({ type: "START_FILL", workspaceId: workspace.id, transitionResult: result });
      syncRxToStore(rxState.id, data, storeDispatch);
    } catch (e) {
      setFillError(e?.message || "Failed to start fill");
    }
  };

  // ── NDC scan ──
  const handleScan = (value) => {
    const cleaned = value.replace(/[^0-9-]/g, "");
    setScannedNdc(cleaned);
    if (cleaned.length >= 10) {
      // Compare normalized (strip dashes)
      const normalScan = cleaned.replace(/-/g, "");
      const normalExpected = expectedNdc.replace(/-/g, "");
      setScanResult(normalScan === normalExpected ? "match" : "mismatch");
    } else {
      setScanResult(null);
    }
  };

  // ── Submit fill ──
  const canSubmitFill = scanResult === "match"
    && (!needsQtyConfirm || (confirmedQty && parseInt(confirmedQty, 10) > 0))
    && canDo("SUBMIT_FILL");

  const handleSubmitFill = async () => {
    if (!canSubmitFill) return;
    const fillData = {
      scannedNdc,
      expectedNdc,
      ndcMatch: true,
      confirmedQty: needsQtyConfirm ? parseInt(confirmedQty, 10) : parseInt(te.qty, 10),
      isControl,
    };
    setFillError(null);
    try {
      const result = await data.transitionRx(rxState.id, "SUBMIT_FILL", currentUser.id, currentUser.role, JSON.stringify(fillData));
      dispatch({ type: "SUBMIT_FILL", workspaceId: workspace.id, fillData, transitionResult: result });
      syncRxToStore(rxState.id, data, storeDispatch);
    } catch (e) {
      setFillError(e?.message || "Failed to submit fill");
    }
  };

  // ── Already submitted for fill review ──
  if (rxState.status === "pending_fill_verify") {
    return (
      <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10, marginBottom: 12,
          background: "#1f1a14",
          border: "1px solid #3d3020",
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#e8a030" }}>Awaiting Fill Verification</div>
          <div style={{ fontSize: 11, color: "#e8a030", marginTop: 4 }}>
            {rxState.rxNumber ? `Rx# ${rxState.rxNumber} · ` : ""}Filled {new Date(rxState.fillData.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
        <div style={{ padding: 14, borderRadius: 8, background: T.surface, border: `1px solid ${T.surfaceBorder}`, fontSize: 13, lineHeight: 1.8, color: T.textPrimary, marginBottom: 12 }}>
          <div><span style={{ color: T.textSecondary, display: "inline-block", width: 100 }}>Drug</span><strong>{te.drugName} {te.strength}</strong></div>
          <div><span style={{ color: T.textSecondary, display: "inline-block", width: 100 }}>NDC Scanned</span><span style={{ color: "#4abe6a" }}>✓ {rxState.fillData.scannedNdc}</span></div>
          <div><span style={{ color: T.textSecondary, display: "inline-block", width: 100 }}>Qty</span>{rxState.fillData.confirmedQty} {te.form}</div>
          {isControl && <div><span style={{ color: T.textMuted, display: "inline-block", width: 100 }}>Control</span><span style={{ color: "#e8a030" }}>{te.schedule} — qty double-checked</span></div>}
        </div>
        {rxState.eOrder && <EScriptPanel eOrder={rxState.eOrder} defaultOpen={false} />}
      </div>
    );
  }

  // ── Already filled ──
  if (rxState.status === "ready") {
    return (
      <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10,
          background: "#162018",
          border: "1px solid #1a3d22",
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#4abe6a" }}>Fill Complete — Ready for Pickup</div>
          <div style={{ fontSize: 11, color: "#4abe6a", marginTop: 4 }}>{rxState.rxNumber ? `Rx# ${rxState.rxNumber}` : ""}</div>
        </div>
      </div>
    );
  }

  // ── Approved but not started filling ──
  if (rxState.status === "approved") {
    return (
      <div style={{ padding: 16, fontFamily: T.mono }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10, marginBottom: 16,
          background: "#162018", border: "1px solid #1a3d22", textAlign: "center",
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#4abe6a" }}>Rx Verified — Ready to Fill</div>
          <div style={{ fontSize: 11, color: "#4abe6a", marginTop: 4 }}>Rx# {rxState.rxNumber} · {te.drugName} {te.strength} · Qty: {te.qty}</div>
        </div>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <button onClick={handleStartFill} disabled={!canDo("START_FILL")} style={{
            padding: "12px 32px", borderRadius: 8, border: "none",
            background: canDo("START_FILL") ? color.bg : T.surface,
            color: canDo("START_FILL") ? "#fff" : T.textMuted,
            fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
            fontFamily: T.mono, cursor: canDo("START_FILL") ? "pointer" : "not-allowed",
          }}>
            Begin Fill
          </button>
        </div>
        {rxState.eOrder && <EScriptPanel eOrder={rxState.eOrder} defaultOpen={false} />}
      </div>
    );
  }

  // ── Filling (active fill screen) ──
  return (
    <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
      {/* Rx Summary Card */}
      <div style={{
        padding: 14, borderRadius: 10, marginBottom: 14,
        background: `${color.bg}10`, border: `1.5px solid ${color.bg}40`,
        fontSize: 12, lineHeight: 1.8,
      }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: color.bg, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
          Rx# {rxState.rxNumber}
        </div>
        <div><strong>{te.drugName} {te.strength}</strong></div>
        <div>SIG: {te.sig}</div>
        <div>Qty: <strong>{te.qty}</strong> · Day supply: {te.daySupply} · Refills: {te.refills}</div>
        {isControl && (
          <div style={{
            marginTop: 6, padding: "4px 10px", borderRadius: 4,
            background: "#1f1418", border: "1px solid #3d2228",
            color: "#e45858", fontSize: 11, fontWeight: 700,
          }}>
            CONTROLLED SUBSTANCE — {te.schedule}
          </div>
        )}
      </div>

      {/* NDC Scan */}
      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2,
          color: color.bg, marginBottom: 6,
        }}>
          Scan NDC Barcode *
        </div>
        <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6 }}>
          Expected: <strong style={{ color: T.textPrimary }}>{expectedNdc}</strong>
        </div>
        <input
          ref={setScanInput}
          value={scannedNdc}
          onChange={(e) => handleScan(e.target.value)}
          placeholder="Scan or type NDC..."
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 16,
            fontFamily: T.mono, fontWeight: 700, letterSpacing: 1,
            border: `2px solid ${scanResult === "match" ? T.inputFocusBorder : scanResult === "mismatch" ? "#e45858" : T.inputBorder}`,
            background: scanResult === "match" ? T.surfaceRaised : scanResult === "mismatch" ? "#1f1418" : T.inputBg,
            color: T.textPrimary, outline: "none", boxSizing: "border-box",
            transition: "all 0.2s",
          }}
        />
        {scanResult === "match" && (
          <div style={{ marginTop: 6, padding: "6px 12px", borderRadius: 6, background: T.surface, border: `1px solid ${T.surfaceBorder}`, color: T.textSecondary, fontSize: 12, fontWeight: 700 }}>
            NDC Match — correct product
          </div>
        )}
        {scanResult === "mismatch" && (
          <div style={{ marginTop: 6, padding: "6px 12px", borderRadius: 6, background: "#1f1418", border: "1px solid #3d2228", color: "#e45858", fontSize: 12, fontWeight: 700 }}>
            NDC Mismatch — wrong product! Expected {expectedNdc}
          </div>
        )}
      </div>

      {/* Quantity Confirmation for Controls */}
      {needsQtyConfirm && scanResult === "match" && (
        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2,
            color: "#e45858", marginBottom: 6,
          }}>
            Confirm Quantity Counted *
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6 }}>
            Prescribed qty: <strong style={{ color: T.textPrimary }}>{te.qty}</strong> — please count and confirm
          </div>
          <input
            value={confirmedQty}
            onChange={(e) => setConfirmedQty(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="Enter counted quantity..."
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 16,
              fontFamily: T.mono, fontWeight: 700,
              border: `2px solid #e4585840`, background: T.inputBg,
              color: T.textPrimary, outline: "none", boxSizing: "border-box",
            }}
          />
          {confirmedQty && parseInt(confirmedQty, 10) !== parseInt(te.qty, 10) && (
            <div style={{ marginTop: 6, padding: "6px 12px", borderRadius: 6, background: "#1f1a14", border: "1px solid #3d3020", color: "#e8a030", fontSize: 11, fontWeight: 700 }}>
              Counted qty ({confirmedQty}) differs from prescribed qty ({te.qty})
            </div>
          )}
        </div>
      )}

      {/* Submit Fill */}
      <button onClick={handleSubmitFill} disabled={!canSubmitFill} style={{
        width: "100%", padding: "12px 16px", borderRadius: T.radiusSm, border: "none",
        background: canSubmitFill ? color.bg : T.surface,
        color: canSubmitFill ? "#fff" : T.textMuted,
        fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
        fontFamily: T.mono,
        cursor: canSubmitFill ? "pointer" : "not-allowed",
        transition: "all 0.2s",
      }}>
        Submit Fill for Verification
      </button>
      {fillError && (
        <div style={{ marginTop: 8, padding: "6px 12px", borderRadius: 6, background: "#1f1418", border: "1px solid #3d2228", color: "#e45858", fontSize: 11, fontFamily: T.mono }}>
          {fillError}
        </div>
      )}

      {/* E-script reference */}
      {rxState.eOrder && (
        <div style={{ marginTop: 14 }}>
          <EScriptPanel eOrder={rxState.eOrder} defaultOpen={false} />
        </div>
      )}
    </div>
  );
}


// ============================================================
// FILL VERIFY — RPh verifies the fill
// ============================================================
function FillVerifyContent({ patient, workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo, currentUser } = useContext(PharmIDEContext);
  const { storeDispatch, getEntity } = useData();
  const color = workspace.color;
  const rxStateWs = workspace.rxPrescription;
  const storeRx = rxStateWs?.id ? getEntity('prescription', rxStateWs.id) : null;
  const rxState = rxStateWs ? {
    ...rxStateWs,
    techEntryData: rxStateWs.techEntryData ?? storeRx?.techEntryData ?? null,
    fillData: rxStateWs.fillData ?? storeRx?.fillData ?? null,
    rphFillReviewData: rxStateWs.rphFillReviewData ?? storeRx?.rphFillReviewData ?? null,
  } : null;

  const [notes, setNotes] = useState("");
  const [checks, setChecks] = useState({ product: false, qty: false, rxInfo: false });
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState(null);

  // ── Not ready ──
  if (!rxState || !["pending_fill_verify", "ready"].includes(rxState.status)) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: T.textMuted, fontFamily: T.mono }}>
        
        <div style={{ fontSize: 13 }}>
          {!rxState ? "No prescription to verify" :
            rxState.status === "in_fill" ? "Tech is filling — not yet submitted" :
              "Fill not ready for verification"}
        </div>
      </div>
    );
  }

  const te = rxState.techEntryData;
  const fd = rxState.fillData;
  const drug = data.getDrug(te.drugId);
  const isControl = te.schedule?.startsWith("C-");
  const allChecked = Object.values(checks).every(Boolean);

  const handleDecision = async (decision) => {
    if (!canDo("RPH_VERIFY_FILL") || deciding) return;
    const actionMap = { approve: "RPH_VERIFY_FILL", refill: "RPH_REJECT_FILL" };
    const rxAction = actionMap[decision];
    setDeciding(true);
    setDecisionError(null);
    try {
      const result = await data.transitionRx(rxState.id, rxAction, currentUser.id, currentUser.role, JSON.stringify({ notes }));
      dispatch({ type: rxAction, workspaceId: workspace.id, notes, transitionResult: result });
      syncRxToStore(rxState.id, data, storeDispatch);
    } catch (e) {
      setDecisionError(e?.message || "Action failed — try again");
    } finally {
      setDeciding(false);
    }
  };

  // ── Already decided ──
  if (rxState.status === "ready") {
    const review = rxState.rphFillReviewData;
    return (
      <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
        <div style={{
          padding: "14px 18px", borderRadius: 10,
          background: T.surface,
          border: `1px solid ${T.surfaceBorder}`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: T.textPrimary }}>Fill Verified — Ready for Pickup</div>
          <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 4 }}>
            {rxState.rxNumber ? `Rx# ${rxState.rxNumber} · ` : ""}Verified {review?.decidedAt ? new Date(review.decidedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
          </div>
        </div>
        {review?.notes && (
          <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 8, background: T.surface, border: `1px solid ${T.surfaceBorder}`, fontSize: 12, color: T.textSecondary }}>
            <strong style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>RPh Notes:</strong>
            <div style={{ marginTop: 4 }}>{review.notes}</div>
          </div>
        )}
      </div>
    );
  }

  // ── Fill review ──
  return (
    <div style={{ padding: 16, fontFamily: T.mono, color: T.textPrimary }}>
      {/* Header */}
      <div style={{
        padding: "10px 14px", borderRadius: 8, marginBottom: 12,
        background: `${color.bg}15`, border: `1.5px solid ${color.bg}40`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: color.bg }}>Fill Verification</div>
          <div style={{ fontSize: 11, color: T.textMuted }}>{rxState.rxNumber ? `Rx# ${rxState.rxNumber} · ` : ""}{patient.name}</div>
        </div>
        <div style={{ fontSize: 11, color: T.textMuted }}>
          {Object.values(checks).filter(Boolean).length}/{Object.keys(checks).length} checked
        </div>
      </div>

      {/* Allergy Banner */}
      {patient.allergies?.length > 0 && (
        <div style={{
          padding: "8px 14px", borderRadius: 8, marginBottom: 12,
          background: "#1f1418", border: "1px solid #3d2228",
          color: "#e45858", fontSize: 11, fontWeight: 700,
        }}>
          ALLERGIES: {patient.allergies.join(" · ")}
        </div>
      )}

      {/* Rx Info Summary */}
      <div style={{
        padding: 12, borderRadius: 8, marginBottom: 12,
        background: T.surface, border: `1px solid ${T.surfaceBorder}`,
        fontSize: 13, lineHeight: 1.8, color: T.textPrimary,
      }}>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>Drug</span><strong>{te.drugName} {te.strength}</strong></div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>SIG</span>{te.sig}</div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>Qty</span>{te.qty} · Day supply: {te.daySupply}</div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>Prescriber</span>{te.prescriberName}</div>
        <div><span style={{ color: T.textSecondary, display: "inline-block", width: 90 }}>NDC</span><span style={{ color: T.textPrimary }}>✓ {fd.scannedNdc}</span></div>
        {isControl && (
          <div><span style={{ color: T.textMuted, display: "inline-block", width: 90 }}>Control</span><span style={{ color: "#e45858", fontWeight: 700 }}>{te.schedule} — Counted: {fd.confirmedQty}</span></div>
        )}
      </div>

      {/* E-script reference */}
      {rxState.eOrder && (
        <div style={{ marginBottom: 12 }}>
          <EScriptPanel eOrder={rxState.eOrder} defaultOpen={false} />
        </div>
      )}

      {/* Verification Checklist */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2, color: color.bg, marginBottom: 8 }}>
          Verification Checklist
        </div>
        {[
          { key: "product", label: "Product appears correct (visual check)" },
          { key: "qty", label: isControl ? `Quantity verified: ${fd.confirmedQty} ${te.form}s (controlled)` : `Quantity appears correct: ${te.qty} ${te.form}s` },
          { key: "rxInfo", label: "Rx information reviewed and appropriate" },
        ].map(item => (
          <div key={item.key}
            onClick={() => setChecks(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
              borderRadius: T.radiusSm, marginBottom: 4, cursor: "pointer",
              border: `1px solid ${checks[item.key] ? T.surfaceBorder : T.surfaceBorder}`,
              background: checks[item.key] ? T.surfaceHover : "transparent",
              transition: "all 0.15s",
            }}
          >
            <div style={{
              width: 20, height: 20, borderRadius: 4, flexShrink: 0,
              border: `2px solid ${checks[item.key] ? T.textAccent : T.surfaceBorder}`,
              background: checks[item.key] ? T.textAccent : T.inputBg,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: 12, fontWeight: 800,
            }}>
              {checks[item.key] ? "✓" : ""}
            </div>
            <span style={{ fontSize: 13, color: checks[item.key] ? T.textPrimary : T.textSecondary }}>{item.label}</span>
          </div>
        ))}
      </div>

      {/* Notes */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2, color: T.textMuted, marginBottom: 6 }}>
          Pharmacist Notes
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes..."
          rows={2}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 12,
            fontFamily: T.mono, border: `1px solid ${T.inputBorder}`,
            background: T.surfaceRaised, color: T.textPrimary, outline: "none", boxSizing: "border-box",
            resize: "vertical",
          }}
        />
      </div>

      {/* Decision Buttons */}
      {canDo("RPH_VERIFY_FILL") ? (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={() => handleDecision("approve")} disabled={!allChecked || deciding} style={{
              padding: "10px 8px", borderRadius: 8, border: "none",
              cursor: (allChecked && !deciding) ? "pointer" : "not-allowed",
              background: allChecked ? "#4abe6a" : T.surface,
              color: allChecked ? "#fff" : T.textMuted,
              fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
              fontFamily: T.mono, transition: "all 0.2s",
              boxShadow: allChecked ? "0 4px 12px #16a34a40" : "none",
              opacity: deciding ? 0.6 : 1,
            }}>
              {deciding ? "…" : "Approve Fill"}
            </button>
            <button onClick={() => handleDecision("refill")} disabled={deciding} style={{
              padding: "10px 8px", borderRadius: 8, border: "1px solid #3d2228",
              background: "#1f1418", color: "#e45858", cursor: deciding ? "not-allowed" : "pointer",
              fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
              fontFamily: T.mono, opacity: deciding ? 0.6 : 1,
            }}>
              Reject — Refill
            </button>
          </div>
          {decisionError && (
            <div style={{ marginTop: 8, padding: "6px 12px", borderRadius: 6, background: "#1f1418", border: "1px solid #3d2228", color: "#e45858", fontSize: 11, fontFamily: T.mono }}>
              {decisionError}
            </div>
          )}
        </div>
      ) : (
        <div style={{
          padding: "12px 16px", borderRadius: 8, background: "#1e293b",
          color: T.textMuted, fontSize: 12, textAlign: "center",
          fontFamily: T.mono, fontStyle: "italic",
        }}>
          Pharmacist verification required — tech view only
        </div>
      )}
    </div>
  );
}


// ============================================================
// SOLD / DISPENSED CONFIRMATION
// ============================================================
function SoldContent({ patient, workspace }) {
  const rx = workspace?.rxPrescription;
  const te = rx?.techEntryData || {};
  const fd = rx?.fillData || {};

  if (rx?.status !== "sold") {
    return (
      <div style={{ padding: 24, color: T.textMuted, fontFamily: T.mono, fontSize: 13 }}>
        Prescription not yet dispensed.
      </div>
    );
  }

  const prescriberObj = te.prescriber || {};
  const prescriberName = prescriberObj.lastName
    ? `${prescriberObj.firstName || ''} ${prescriberObj.lastName}`.trim()
    : (typeof te.prescriber === 'string' ? te.prescriber : null);

  const rows = [
    ["Patient",      patient?.name],
    ["Rx #",         rx.rxNumber || "—"],
    ["Drug",         [te.drugName, te.strength, te.form].filter(Boolean).join(" ") || "—"],
    ["NDC",          fd.scannedNdc || "—"],
    ["Qty",          fd.confirmedQty ?? te.qty ?? "—"],
    ["Days Supply",  te.daysSupply ?? "—"],
    ["Prescriber",   prescriberName || "—"],
    ["Dispensed",    new Date().toLocaleString()],
  ];

  return (
    <div style={{ padding: 24, fontFamily: T.mono, fontSize: 13, overflowY: "auto", height: "100%" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        background: "#14532d22", border: "1px solid #16a34a55",
        borderRadius: T.radius, padding: "8px 18px", marginBottom: 20,
        color: "#4ade80", fontWeight: 700, fontSize: 15,
      }}>
        ✓ Dispensed
      </div>
      <div style={{
        background: T.surface, border: `1px solid ${T.surfaceBorder}`,
        borderRadius: T.radius, overflow: "hidden",
      }}>
        {rows.map(([label, val]) => (
          <div key={label} style={{
            display: "grid", gridTemplateColumns: "130px 1fr",
            padding: "9px 16px", borderBottom: `1px solid ${T.surfaceBorder}`,
          }}>
            <span style={{ color: T.textMuted, fontWeight: 600 }}>{label}</span>
            <span style={{ color: T.textPrimary }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// NEW PATIENT PROFILE FORM — shown in intake queue when patient has no profile on file
// ============================================================
function NewPatientProfileForm({ patient, color, onConfirm }) {
  const [draft, setDraft] = useState(() => ({
    firstName: patient?.firstName || '',
    lastName: patient?.lastName || '',
    dob: patient?.dob || '',
    gender: patient?.gender || '',
    phone: patient?.phone || '',
    address1: patient?.address1 || '',
    address2: patient?.address2 || '',
    city: patient?.city || '',
    state: patient?.state || '',
    zip: patient?.zip || '',
    allergiesText: '',
    insurancePlan: '',
    insuranceMemberId: '',
    insuranceGroup: '',
    insuranceCopay: '',
    notes: '',
  }));

  const set = (field) => (e) => setDraft(p => ({ ...p, [field]: e.target.value }));
  const canConfirm = draft.firstName.trim() && draft.lastName.trim() && draft.dob.trim();

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm({
      name: `${draft.firstName.trim()} ${draft.lastName.trim()}`,
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      dob: draft.dob.trim(),
      gender: draft.gender,
      phone: draft.phone,
      address: serializeAddress(draft),
      address1: draft.address1,
      address2: draft.address2,
      city: draft.city,
      state: draft.state,
      zip: draft.zip,
      allergies: draft.allergiesText
        ? draft.allergiesText.split(',').map(a => a.trim()).filter(Boolean)
        : [],
      medications: patient?.medications || [],
      insurance: {
        plan: draft.insurancePlan,
        memberId: draft.insuranceMemberId,
        group: draft.insuranceGroup,
        copay: draft.insuranceCopay,
      },
      notes: draft.notes,
      isNewPatient: false,
    });
  };

  const inp = {
    background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 4,
    color: '#f8fafc', fontSize: 11, padding: '4px 8px', fontFamily: T.mono,
    outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  const lbl = {
    fontSize: 9, color: T.textMuted, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3,
  };
  const sectionHdr = (col) => ({
    fontSize: 9, fontWeight: 800, color: col || T.textMuted,
    textTransform: 'uppercase', letterSpacing: '0.1em',
    marginBottom: 8, marginTop: 14, paddingBottom: 4,
    borderBottom: `1px solid ${col ? col + '40' : T.surfaceBorder}`,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Warning header */}
      <div style={{
        padding: '8px 12px', background: '#1a1600',
        borderBottom: '1px solid #92400e', flexShrink: 0,
      }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#fbbf24', fontFamily: T.mono }}>
          ⚠ New Patient — Not on File
        </div>
        <div style={{ fontSize: 10, color: '#d97706', marginTop: 2 }}>
          Pre-filled from e-script. Confirm to register in patients.db.
        </div>
      </div>

      {/* Scrollable form body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px' }}>
        <div style={sectionHdr()}>Demographics</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <div>
            <div style={lbl}>First Name *</div>
            <input style={inp} value={draft.firstName} onChange={set('firstName')} />
          </div>
          <div>
            <div style={lbl}>Last Name *</div>
            <input style={inp} value={draft.lastName} onChange={set('lastName')} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <div>
            <div style={lbl}>DOB * (MM/DD/YYYY)</div>
            <input style={inp} value={draft.dob} onChange={set('dob')} placeholder="MM/DD/YYYY" />
          </div>
          <div>
            <div style={lbl}>Gender</div>
            <select style={{ ...inp, cursor: 'pointer' }} value={draft.gender} onChange={set('gender')}>
              <option value="">—</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>Phone</div>
          <input style={inp} value={draft.phone} onChange={set('phone')} placeholder="(xxx) xxx-xxxx" />
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>Street Address</div>
          <input style={inp} value={draft.address1} onChange={set('address1')} placeholder="Street address" />
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>Apt / Suite</div>
          <input style={inp} value={draft.address2} onChange={set('address2')} placeholder="Optional" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 52px 80px", gap: 8, marginBottom: 8 }}>
          <div>
            <div style={lbl}>City</div>
            <input style={inp} value={draft.city} onChange={set('city')} />
          </div>
          <div>
            <div style={lbl}>State</div>
            <input style={inp} value={draft.state} maxLength={2}
              onChange={e => setDraft(p => ({ ...p, state: e.target.value.toUpperCase().slice(0, 2) }))}
              placeholder="CO" />
          </div>
          <div>
            <div style={lbl}>ZIP</div>
            <input style={inp} value={draft.zip} onChange={set('zip')} />
          </div>
        </div>

        <div style={sectionHdr('#e45858')}>Allergies</div>
        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>Known Allergies (comma-separated, leave blank if none)</div>
          <input style={inp} value={draft.allergiesText} onChange={set('allergiesText')} placeholder="Penicillin, Sulfa, Latex..." />
        </div>

        <div style={sectionHdr()}>Insurance</div>
        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>Plan</div>
          <input style={inp} value={draft.insurancePlan} onChange={set('insurancePlan')} placeholder="Insurance plan name" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <div>
            <div style={lbl}>Member ID</div>
            <input style={inp} value={draft.insuranceMemberId} onChange={set('insuranceMemberId')} />
          </div>
          <div>
            <div style={lbl}>Group</div>
            <input style={inp} value={draft.insuranceGroup} onChange={set('insuranceGroup')} />
          </div>
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={lbl}>Copay</div>
          <input style={inp} value={draft.insuranceCopay} onChange={set('insuranceCopay')} placeholder="$10/$30/$50" />
        </div>

        <div style={sectionHdr()}>Notes</div>
        <div style={{ marginBottom: 8 }}>
          <textarea
            style={{ ...inp, resize: 'vertical', minHeight: 52, lineHeight: 1.4 }}
            value={draft.notes}
            onChange={set('notes')}
            placeholder="Special instructions, preferences, pickup notes..."
            rows={2}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{
        padding: '10px 12px', borderTop: `1px solid ${T.surfaceBorder}`,
        flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          style={{
            width: '100%', padding: '9px 12px', borderRadius: 6, border: 'none',
            background: canConfirm ? `linear-gradient(135deg, ${color.bg}, ${color.bg}cc)` : T.surface,
            color: canConfirm ? '#fff' : T.textMuted,
            fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1,
            fontFamily: T.mono, cursor: canConfirm ? 'pointer' : 'not-allowed',
            boxShadow: canConfirm ? `0 4px 12px ${color.bg}40` : 'none',
          }}
        >
          Confirm & Open
        </button>
      </div>
    </div>
  );
}


// ============================================================
// DATA ENTRY WORKSPACE — Task-focused throughput workspace
// ============================================================
function DataEntryWorkspaceContent({ workspace }) {
  const data = useDataProvider();
  const { dispatch, canDo, state } = useContext(PharmIDEContext);
  const { getEntity, getEntities, updateEntity } = useData();
  const color = workspace.color;

  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [activeRx, setActiveRx] = useState(false); // false = queue view, true = entry view
  const [backendEOrders, setBackendEOrders] = useState([]);

  // Load e-orders from backend asynchronously (static snapshot — generated scripts come via store)
  useEffect(() => {
    let mounted = true;
    Promise.resolve(data.getAllEOrders()).then(eos => {
      if (mounted) setBackendEOrders(eos || []);
    }).catch(() => {
      if (mounted) setBackendEOrders([]);
    });
    return () => { mounted = false; };
  }, [data]);

  // Merge backend e-orders with live-generated ones from the store (reactive)
  const generatedEOrders = getEntities('eorder');
  const allEOrders = useMemo(() => {
    const bePatients = new Set(backendEOrders.map(e => e.patientId));
    return [
      ...backendEOrders,
      ...generatedEOrders.filter(e => !bePatients.has(e.patientId)),
    ].sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  }, [backendEOrders, generatedEOrders]);

  // Patients are considered "processed" (removed from queue) only once their
  // Rx has been submitted — i.e., status is past the entry phase.
  // While status is incoming/in_entry, the eorder stays visible so the tech
  // can still see it and continue working.
  const processedPatientIds = useMemo(() => {
    const entryStatuses = new Set(["incoming", "in_entry", null, undefined]);
    return new Set(
      Object.values(state.workspaces)
        .filter(ws => ws.patientId && ws.rxPrescription && !entryStatuses.has(ws.rxPrescription.status))
        .map(ws => ws.patientId)
    );
  }, [state.workspaces]);

  const pendingEOrders = useMemo(() => {
    return allEOrders.filter(eo => !processedPatientIds.has(eo.patientId));
  }, [allEOrders, processedPatientIds]);

  const selectedPatient = selectedPatientId ? getEntity('patient', selectedPatientId) : null;
  // Find the selected eorder from the loaded list (no second async call needed)
  const selectedEOrder = useMemo(
    () => allEOrders.find(eo => eo.patientId === selectedPatientId) || null,
    [allEOrders, selectedPatientId]
  );

  // Check if patient has other active work
  const patientActiveWork = useMemo(() => {
    if (!selectedPatientId) return [];
    return Object.values(state.workspaces)
      .filter(ws => ws.patientId === selectedPatientId && ws.rxPrescription)
      .map(ws => ws.rxPrescription);
  }, [selectedPatientId, state.workspaces]);

  // Handle opening an Rx for entry — just create the workspace.
  // markEOrderResolved fires later, in RxEntryContent.handleSubmit, so the
  // eorder stays visible in this queue until the tech actually submits.
  const handleOpenRx = () => {
    if (!selectedPatientId) return;
    dispatch({ type: "CREATE_WORKSPACE", patientId: selectedPatientId, eOrder: selectedEOrder || null });
    setActiveRx(true);
  };

  // Handle confirming a new patient profile — save to DB then open workspace.
  // Workspace opens immediately; the DB save happens in the background so the
  // tech doesn't wait on the network round-trip.
  const handleConfirmNewPatient = (profileData) => {
    dispatch({ type: "CREATE_WORKSPACE", patientId: selectedPatientId, eOrder: selectedEOrder || null });
    setActiveRx(true);
    updateEntity('patient', selectedPatientId, profileData).catch(() => {});
  };

  // Handle finishing and going back to queue
  const handleBackToQueue = () => {
    setActiveRx(false);
    setSelectedPatientId(null);
  };

  // Get the patient workspace if it exists (for the embedded entry form)
  const patientWorkspace = useMemo(() => {
    return Object.values(state.workspaces).find(ws => ws.patientId === selectedPatientId);
  }, [selectedPatientId, state.workspaces]);

  // If actively entering, show embedded entry form + context panel
  if (activeRx && selectedPatient && patientWorkspace) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 0, height: "100%", overflow: "hidden" }}>
        {/* Left: Rx Entry Form */}
        <div style={{ overflow: "auto", padding: 2, borderRight: "1px solid #e2e8f0" }}>
          {/* Back button + patient header */}
          <div style={{
            padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between",
            borderBottom: `1px solid ${T.surfaceBorder}`, marginBottom: 2,
          }}>
            <button onClick={handleBackToQueue} style={{
              background: "none", border: `1px solid ${T.inputBorder}`, borderRadius: 6,
              padding: "4px 12px", fontSize: 11, color: T.textMuted, cursor: "pointer",
              fontFamily: T.mono, fontWeight: 600,
            }}>
              ← Queue
            </button>
            <div style={{ fontSize: 12, fontWeight: 700, color: color.bg }}>
              {selectedPatient.name}
              <span style={{ fontWeight: 400, color: T.textMuted, marginLeft: 8, fontSize: 11 }}>DOB: {selectedPatient.dob}</span>
            </div>
          </div>
          <RxEntryContent patient={selectedPatient} workspace={patientWorkspace} />
        </div>

        {/* Right: Mini-tile context panel */}
        <div style={{
          overflow: "auto", background: T.surface,
          fontFamily: T.mono, fontSize: 12,
        }}>
          <div style={{
            padding: "8px 12px", borderBottom: `1px solid ${T.surfaceBorder}`,
            fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
            color: T.textMuted,
          }}>
            Patient Context
          </div>

          {/* Allergies */}
          {selectedPatient.allergies?.length > 0 && (
            <MiniCard title="Allergies" color="#dc2626">
              <div style={{ color: "#e45858", fontWeight: 700 }}>
                {selectedPatient.allergies.join(" · ")}
              </div>
            </MiniCard>
          )}

          {/* Current Meds */}
          <MiniCard title="Current Medications" color={T.textMuted}>
            {selectedPatient.medications?.length > 0 ? selectedPatient.medications.map((med, i) => (
              <div key={i} style={{ marginBottom: 4, lineHeight: 1.4 }}>
                <div style={{ fontWeight: 600, color: T.textPrimary, fontSize: 11 }}>{med.name}</div>
                <div style={{ color: T.textMuted, fontSize: 10 }}>{med.directions}</div>
              </div>
            )) : <div style={{ color: T.textSecondary, fontStyle: "italic" }}>No medications on file</div>}
          </MiniCard>

          {/* Insurance */}
          <MiniCard title="Insurance" color={T.textMuted}>
            <div style={{ lineHeight: 1.6, fontSize: 11 }}>
              <div><strong>{selectedPatient.insurance?.plan}</strong></div>
              <div style={{ color: T.textMuted }}>ID: {selectedPatient.insurance?.memberId}</div>
              <div style={{ color: T.textMuted }}>Copay: {selectedPatient.insurance?.copay}</div>
            </div>
          </MiniCard>

          {/* Notes */}
          {selectedPatient.notes && (
            <MiniCard title="Notes" color={T.textMuted}>
              <div style={{ color: T.textSecondary, lineHeight: 1.5, fontSize: 11 }}>{selectedPatient.notes}</div>
            </MiniCard>
          )}

          {/* Active Work */}
          {patientActiveWork.length > 0 && (
            <MiniCard title="Active Rxs" color={T.textMuted}>
              {patientActiveWork.map((rx, i) => (
                <div key={i} style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 11, color: T.textPrimary }}>{rx.techEntryData?.drugName} {rx.techEntryData?.strength}</div>
                    {rx.rxNumber && <div style={{ fontSize: 9, color: T.textMuted, fontFamily: T.mono }}>Rx# {rx.rxNumber}</div>}
                  </div>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
                    background: T.surface, color: T.textMuted,
                  }}>
                    {rx.status}
                  </span>
                </div>
              ))}
            </MiniCard>
          )}
        </div>
      </div>
    );
  }

  // Queue view — list of pending e-orders + preview panel
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 0, height: "100%", overflow: "hidden" }}>
      {/* Left: Queue list */}
      <div style={{ overflow: "auto", fontFamily: T.mono }}>
        <div style={{
          padding: "10px 14px", borderBottom: `1px solid ${T.surfaceBorder}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <span style={{ fontSize: 14, fontWeight: 800, color: color.bg }}>Data Entry Queue</span>
            <span style={{ fontSize: 11, color: T.textMuted, marginLeft: 10 }}>{pendingEOrders.length} pending</span>
          </div>
        </div>

        {pendingEOrders.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textSecondary }}>
            
            <div style={{ fontSize: 13 }}>Queue is clear — all caught up!</div>
          </div>
        ) : (
          <div>
            {pendingEOrders.map((eo) => {
              const isSelected = selectedPatientId === eo.patientId;
              const hasActiveWork = Object.values(state.workspaces).some(ws => ws.patientId === eo.patientId && ws.rxPrescription);
              const age = Math.floor((Date.now() - new Date(eo.receivedAt).getTime()) / 60000);
              const resolved = data.resolveEOrder(eo);
              const eoPt = getEntity('patient', eo.patientId);
              const ptName = eoPt?.name || eo.transcribed?.patient || '';
              const ptAllergies = eoPt?.allergies || [];
              return (
                <div
                  key={eo.messageId}
                  onClick={() => setSelectedPatientId(eo.patientId)}
                  style={{
                    padding: "10px 14px", cursor: "pointer",
                    borderBottom: `1px solid ${T.surfaceBorder}`,
                    borderLeft: isSelected ? `3px solid ${color.bg}` : "3px solid transparent",
                    background: isSelected ? `${color.bg}08` : "transparent",
                    transition: "all 0.1s",
                  }}
                  onMouseOver={(e) => { if (!isSelected) e.currentTarget.style.background = "#fafafa"; }}
                  onMouseOut={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary }}>
                        {eo.transcribed?.drug}
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                        {ptName}
                        <span style={{ color: "#cbd5e1", margin: "0 4px" }}>·</span>
                        {eo.transcribed?.prescriber}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <span style={{
                        fontSize: 9, color: age > 30 ? "#dc2626" : age > 15 ? "#d97706" : "#64748b",
                        fontWeight: age > 15 ? 700 : 400,
                      }}>
                        {age}m ago
                      </span>
                      {resolved?.drug?.confidence && (
                        <span style={{
                          fontSize: 8, padding: "1px 5px", borderRadius: 3,
                          background: T.surface, color: T.textMuted,
                          fontWeight: 700,
                        }}>
                          {resolved.drug.confidence} match
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Flags row */}
                  <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                    {hasActiveWork && (
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: T.surface, color: T.textMuted, border: `1px solid ${T.surfaceBorder}` }}>
                        HAS ACTIVE RX
                      </span>
                    )}
                    {ptAllergies.length > 0 && (
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "#1f1418", color: "#e45858", border: "1px solid #3d2228" }}>
                        ALLERGIES
                      </span>
                    )}
                    {eo.transcribed?.note && (
                      <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: T.surface, color: T.textMuted, border: `1px solid ${T.surfaceBorder}` }}>
                        HAS NOTE
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right: Preview panel */}
      <div style={{
        overflow: "auto", background: T.surface, borderLeft: `1px solid ${T.surfaceBorder}`,
        fontFamily: T.mono,
      }}>
        {selectedPatient && selectedEOrder ? (
          selectedPatient.isNewPatient ? (
            <NewPatientProfileForm
              patient={selectedPatient}
              color={color}
              onConfirm={handleConfirmNewPatient}
            />
          ) : (
          <>
            {/* Patient header */}
            <div style={{
              padding: "10px 12px", borderBottom: `1px solid ${T.surfaceBorder}`,
              background: T.surfaceRaised,
            }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.textPrimary }}>{selectedPatient.name}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                DOB: {selectedPatient.dob} · {selectedPatient.phone}
              </div>
            </div>

            {/* Allergies - safety gate, always visible */}
            {selectedPatient.allergies?.length > 0 && (
              <MiniCard title="Allergies" color="#dc2626">
                <div style={{ color: "#e45858", fontWeight: 700 }}>
                  {selectedPatient.allergies.join(" · ")}
                </div>
              </MiniCard>
            )}

            {/* OPERATIONAL: What's happening with this patient RIGHT NOW */}
            {(() => {
              const statusConfig = {
                in_review: { label: "RPh Review", bg: T.surface, fg: T.textSecondary, icon: "" },
                approved: { label: "Ready to Fill", bg: T.surface, fg: T.textSecondary, icon: "" },
                filling: { label: "Filling", bg: T.surface, fg: T.textSecondary, icon: "" },
                fill_review: { label: "Fill Check", bg: T.surface, fg: T.textSecondary, icon: "" },
                filled: { label: "Pickup", bg: T.surface, fg: T.textSecondary, icon: "" },
                returned: { label: "Returned", bg: "#1f1418", fg: "#dc2626", icon: "↩" },
                call_prescriber: { label: "Call Dr", bg: "#1f1a14", fg: "#e8a030", icon: "☎" },
              };
              return patientActiveWork.length > 0 ? (
                <MiniCard title={`In System · ${patientActiveWork.length} Active`} color={T.textMuted}>
                  {patientActiveWork.map((rx, i) => {
                    const sc = statusConfig[rx.status] || { label: rx.status || "new", bg: "#f1f5f9", fg: "#64748b", icon: "·" };
                    const ageMin = rx.techEntryData?.submittedAt ? Math.round((Date.now() - rx.techEntryData.submittedAt) / 60000) : null;
                    return (
                      <div key={i} style={{
                        marginBottom: 6, padding: "6px 8px", borderRadius: 6,
                        background: sc.bg, border: `1px solid ${sc.fg}30`,
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: T.textPrimary }}>
                            {rx.techEntryData?.drugName} {rx.techEntryData?.strength}
                          </span>
                          <span style={{
                            fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                            background: `${sc.fg}20`, color: sc.fg,
                            fontFamily: T.mono,
                          }}>
                            {sc.icon} {sc.label}
                          </span>
                        </div>
                        <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2, display: "flex", gap: 8 }}>
                          {rx.rxNumber && <span>Rx# {rx.rxNumber}</span>}
                          {ageMin != null && (
                            <span style={{ color: ageMin > 30 ? "#dc2626" : ageMin > 15 ? "#d97706" : "#64748b" }}>
                              {ageMin}m ago
                            </span>
                          )}
                          {rx.techEntryData?.prescriberName && <span>Dr: {rx.techEntryData.prescriberName}</span>}
                        </div>
                      </div>
                    );
                  })}
                </MiniCard>
              ) : (
                <div style={{
                  margin: "0 12px", padding: "8px 12px", borderRadius: 6,
                  background: T.surface, border: `1px solid ${T.surfaceBorder}`,
                  fontSize: 11, color: T.textSecondary, textAlign: "center",
                  fontFamily: T.mono,
                }}>
                  No active scripts in system
                </div>
              );
            })()}

            {/* E-Order Preview - what you're about to work on */}
            <div style={{ padding: "8px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
              <EScriptPanel eOrder={selectedEOrder} defaultOpen={true} />
            </div>

            {/* Insurance - need for adjudication */}
            <MiniCard title="Insurance" color={T.textMuted}>
              <div style={{ lineHeight: 1.6, fontSize: 11 }}>
                <div><strong>{selectedPatient.insurance?.plan}</strong></div>
                <div style={{ color: T.textMuted }}>ID: {selectedPatient.insurance?.memberId}</div>
                <div style={{ color: T.textMuted }}>Copay: {selectedPatient.insurance?.copay}</div>
              </div>
            </MiniCard>

            {/* Notes - operational flags */}
            {selectedPatient.notes && (
              <MiniCard title="Notes" color={T.textMuted}>
                <div style={{ color: T.textSecondary, lineHeight: 1.5, fontSize: 11 }}>{selectedPatient.notes}</div>
              </MiniCard>
            )}

            {/* Current Meds - collapsed, clinical reference only */}
            <details style={{ margin: "0 12px 8px" }}>
              <summary style={{
                fontSize: 10, fontWeight: 700, color: T.textSecondary, cursor: "pointer",
                padding: "6px 0", textTransform: "uppercase", letterSpacing: 0.5,
                fontFamily: T.mono,
              }}>
                Med History ({selectedPatient.medications?.length || 0})
              </summary>
              <div style={{ padding: "4px 0" }}>
                {selectedPatient.medications?.length > 0 ? selectedPatient.medications.map((med, i) => (
                  <div key={i} style={{ marginBottom: 3, lineHeight: 1.3 }}>
                    <span style={{ fontWeight: 600, color: T.textSecondary, fontSize: 10 }}>{med.name}</span>
                    <span style={{ color: T.textSecondary, fontSize: 10 }}> — {med.directions}</span>
                  </div>
                )) : <div style={{ color: T.textSecondary, fontStyle: "italic", fontSize: 10 }}>None on file</div>}
              </div>
            </details>

            {/* Open button */}
            <div style={{ padding: "12px 12px" }}>
              <button onClick={handleOpenRx} style={{
                width: "100%", padding: "10px 16px", borderRadius: 8, border: "none",
                background: `linear-gradient(135deg, ${color.bg}, ${color.bg}dd)`,
                color: "#fff", fontSize: 12, fontWeight: 800, textTransform: "uppercase",
                letterSpacing: 1, fontFamily: T.mono, cursor: "pointer",
                boxShadow: `0 4px 12px ${color.bg}40`,
              }}>
                Open for Entry
              </button>
            </div>
          </>
          )
        ) : (
          <div style={{ padding: 40, textAlign: "center", color: T.textSecondary }}>
            <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.3 }}>👈</div>
            <div style={{ fontSize: 12 }}>Select an e-script to preview</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Mini card component for context panel
function MiniCard({ title, color, children }) {
  return (
    <div style={{ padding: "8px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
      <div style={{
        fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1,
        color: color, marginBottom: 4,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}


// ============================================================
// OTHER TAB CONTENT COMPONENTS (preserved from prototype)
// ============================================================

// ── Patient profile helpers — defined OUTSIDE PatientProfileContent so React
//    doesn't treat them as new component types on each re-render (which would
//    unmount inputs and kill focus on every keystroke).

function parseAddress(str) {
  const s = (str || "").trim();
  if (!s) return { address1: "", address2: "", city: "", state: "", zip: "" };
  // "street, city, ST XXXXX" (standard)
  let m = s.match(/^(.+),\s*(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m) return { address1: m[1].trim(), address2: "", city: m[2].trim(), state: m[3], zip: m[4] };
  // "street, city ST XXXXX" (city/state not separated by comma)
  m = s.match(/^(.+),\s*(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m) return { address1: m[1].trim(), address2: "", city: m[2].trim(), state: m[3], zip: m[4] };
  return { address1: s, address2: "", city: "", state: "", zip: "" };
}

function serializeAddress({ address1, address2, city, state, zip } = {}) {
  const street = [address1, address2].filter(Boolean).join(", ");
  const cityLine = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, cityLine].filter(Boolean).join(", ");
}

function normalizeDob(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  // Delimited: M/D/YY, M-D-YYYY, M.D.YYYY, etc.
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    const mo = m[1].padStart(2, '0');
    const dy = m[2].padStart(2, '0');
    let yr = m[3];
    if (yr.length === 2) yr = parseInt(yr, 10) <= 30 ? `20${yr}` : `19${yr}`;
    if (yr.length !== 4) return null;
    const moN = parseInt(mo, 10), dyN = parseInt(dy, 10), yrN = parseInt(yr, 10);
    if (moN < 1 || moN > 12 || dyN < 1 || dyN > 31 || yrN < 1900 || yrN > 2100) return null;
    return `${mo}/${dy}/${yr}`;
  }
  // 8-digit MMDDYYYY
  if (/^\d{8}$/.test(s)) {
    const mo = s.slice(0, 2), dy = s.slice(2, 4), yr = s.slice(4, 8);
    const moN = parseInt(mo, 10), dyN = parseInt(dy, 10), yrN = parseInt(yr, 10);
    if (moN < 1 || moN > 12 || dyN < 1 || dyN > 31 || yrN < 1900 || yrN > 2100) return null;
    return `${mo}/${dy}/${yr}`;
  }
  // 6-digit MMDDYY
  if (/^\d{6}$/.test(s)) {
    const mo = s.slice(0, 2), dy = s.slice(2, 4), yy = s.slice(4, 6);
    const yr = parseInt(yy, 10) <= 30 ? `20${yy}` : `19${yy}`;
    const moN = parseInt(mo, 10), dyN = parseInt(dy, 10);
    if (moN < 1 || moN > 12 || dyN < 1 || dyN > 31) return null;
    return `${mo}/${dy}/${yr}`;
  }
  return null;
}

function normalizePhone(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    const d = digits.slice(1);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return null;
}

const PROFILE_INPUT_STYLE = {
  background: T.surface, border: `1px solid ${T.surfaceBorder}`, borderRadius: T.radiusSm,
  color: T.textPrimary, fontSize: 12, padding: "4px 8px", fontFamily: T.mono,
  outline: "none", width: "100%", boxSizing: "border-box",
};

function ProfileSection({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.5,
        color: T.textMuted, marginBottom: 8, paddingBottom: 4,
        borderBottom: `1px solid ${T.surfaceBorder}`,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ProfileField({ label, value, onChange, editMode, multiline }) {
  return (
    <>
      <span style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, paddingTop: 4 }}>{label}</span>
      {editMode
        ? multiline
          ? <textarea value={value} onChange={onChange} rows={3}
              style={{ ...PROFILE_INPUT_STYLE, resize: "vertical", lineHeight: 1.5 }} />
          : <input value={value} onChange={onChange} style={PROFILE_INPUT_STYLE} />
        : <span style={{ fontSize: 12, color: T.textPrimary, paddingTop: 2 }}>
            {value || <span style={{ color: T.textMuted, fontStyle: "italic" }}>—</span>}
          </span>
      }
    </>
  );
}

// Like ProfileField but normalizes/validates on blur. onChange(normalizedString) — not an event.
function ProfileFieldNormalized({ label, value, onChange, onNormalize, editMode, errorHint }) {
  const [localValue, setLocalValue] = useState(value || "");
  const [error, setError] = useState(false);
  useEffect(() => { setLocalValue(value || ""); setError(false); }, [value]);

  const handleBlur = () => {
    if (!localValue.trim()) { onChange(""); setError(false); return; }
    const normalized = onNormalize(localValue);
    if (normalized === null) {
      setError(true);
    } else {
      setError(false);
      setLocalValue(normalized);
      onChange(normalized);
    }
  };

  if (!editMode) return (
    <>
      <span style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, paddingTop: 4 }}>{label}</span>
      <span style={{ fontSize: 12, color: T.textPrimary, paddingTop: 2 }}>
        {value || <span style={{ color: T.textMuted, fontStyle: "italic" }}>—</span>}
      </span>
    </>
  );

  return (
    <>
      <span style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, paddingTop: 4 }}>{label}</span>
      <div>
        <input
          value={localValue}
          onChange={e => { setLocalValue(e.target.value); if (error) setError(false); }}
          onBlur={handleBlur}
          style={{ ...PROFILE_INPUT_STYLE, ...(error ? { borderColor: "#e45858" } : {}) }}
        />
        {error && <div style={{ fontSize: 10, color: "#e45858", marginTop: 2 }}>{errorHint}</div>}
      </div>
    </>
  );
}

function ProfileAddressFields({ values, onChange, editMode }) {
  if (!editMode) {
    const line1 = values.address1 || "";
    const line2 = values.address2 || "";
    const line3 = [values.city, [values.state, values.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const display = [line1, line2, line3].filter(Boolean).join("\n");
    return (
      <>
        <span style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, paddingTop: 4 }}>Address</span>
        <span style={{ fontSize: 12, color: T.textPrimary, paddingTop: 2, whiteSpace: "pre-line" }}>
          {display || <span style={{ color: T.textMuted, fontStyle: "italic" }}>—</span>}
        </span>
      </>
    );
  }
  return (
    <>
      <span style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, paddingTop: 6 }}>Address</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <input value={values.address1 || ""} onChange={e => onChange("address1", e.target.value)}
          placeholder="Street address" style={PROFILE_INPUT_STYLE} />
        <input value={values.address2 || ""} onChange={e => onChange("address2", e.target.value)}
          placeholder="Apt, Suite, Unit (optional)" style={PROFILE_INPUT_STYLE} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 44px 76px", gap: 4 }}>
          <input value={values.city || ""} onChange={e => onChange("city", e.target.value)}
            placeholder="City" style={PROFILE_INPUT_STYLE} />
          <input value={values.state || ""} maxLength={2}
            onChange={e => onChange("state", e.target.value.toUpperCase().slice(0, 2))}
            placeholder="ST" style={{ ...PROFILE_INPUT_STYLE, textAlign: "center", textTransform: "uppercase" }} />
          <input value={values.zip || ""} onChange={e => onChange("zip", e.target.value)}
            placeholder="ZIP" style={PROFILE_INPUT_STYLE} />
        </div>
      </div>
    </>
  );
}

// Parse a DB patient row (JSON strings) into working JS objects
function parsePatientRow(row) {
  const name = row.name || "";
  const spaceIdx = name.indexOf(" ");
  const firstName = spaceIdx >= 0 ? name.slice(0, spaceIdx) : name;
  const lastName = spaceIdx >= 0 ? name.slice(spaceIdx + 1) : "";
  const addrParts = parseAddress(row.address || "");
  return {
    id: row.id,
    name,
    firstName,
    lastName,
    dob: row.dob || "",
    phone: row.phone || "",
    address: row.address || "",
    ...addrParts,
    allergies: row.allergies ? JSON.parse(row.allergies) : [],
    insurance: row.insurance ? JSON.parse(row.insurance) : { plan: "", memberId: "", group: "", copay: "" },
    medications: row.medications ? JSON.parse(row.medications) : [],
    notes: row.notes || "",
  };
}

// Serialize JS objects back to DB row format (JSON strings)
function serializePatientRow(p) {
  const name = (p.firstName || p.lastName)
    ? `${p.firstName || ""} ${p.lastName || ""}`.trim()
    : (p.name || "");
  const address = (p.address1 || p.city || p.state || p.zip)
    ? serializeAddress(p)
    : (p.address || "");
  return {
    id: p.id,
    name,
    dob: p.dob,
    phone: p.phone,
    address,
    allergies: JSON.stringify(p.allergies || []),
    insurance: JSON.stringify(p.insurance || {}),
    medications: JSON.stringify(p.medications || []),
    notes: p.notes,
  };
}

function PatientProfileContent({ patient, workspace }) {
  const { getEntity, updateEntity, storeDispatch } = useData();
  const data = useDataProvider();
  const { state } = useContext(PharmIDEContext);
  const color = workspace.color;
  const [dbRxs, setDbRxs] = useState([]);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [draft, setDraft] = useState(null);

  // On mount: load from DB and seed the store (DB overrides MOCK_PATIENTS if present)
  useEffect(() => {
    data.getPatient(patient.id).then(row => {
      if (row) {
        // Loaded from DB — put the authoritative record into the store
        storeDispatch({ type: 'ENTITY_UPDATED', entityType: 'patient', entityId: patient.id, data: parsePatientRow(row) });
      } else {
        // Not in DB yet — persist the MOCK_PATIENTS baseline so future saves work
        data.upsertPatient(serializePatientRow(patient)).catch(() => {});
      }
    });
    data.getPrescriptionsByPatient(patient.id).then(list => { if (list?.length) setDbRxs(list); });
  }, [patient.id]);

  // Read from store — always fresh, reactive to any update from any component
  const profileData = getEntity('patient', patient.id) || patient;

  const startEdit = () => {
    setDraft({
      ...profileData,
      firstName: profileData.firstName || "",
      lastName: profileData.lastName || "",
      address1: profileData.address1 || "",
      address2: profileData.address2 || "",
      city: profileData.city || "",
      state: profileData.state || "",
      zip: profileData.zip || "",
      insurance: { ...profileData.insurance },
      allergies: [...(profileData.allergies || [])],
    });
    setEditMode(true); setSaveError(null);
  };
  const cancelEdit = () => { setEditMode(false); setDraft(null); setSaveError(null); };

  const handleSave = async () => {
    setSaving(true); setSaveError(null);
    try {
      const name = `${draft.firstName || ""} ${draft.lastName || ""}`.trim() || draft.name;
      const address = serializeAddress(draft);
      await updateEntity('patient', patient.id, { ...draft, name, address });
      setEditMode(false); setDraft(null);
    } catch (e) {
      setSaveError(e?.message || "Save failed");
    } finally { setSaving(false); }
  };

  const D = editMode ? draft : profileData;  // active data to display

  // Age from DOB (MM/DD/YYYY)
  const age = useMemo(() => {
    const parts = (D.dob || "").split("/").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const [m, d, y] = parts;
    const today = new Date();
    let a = today.getFullYear() - y;
    if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) a--;
    return a;
  }, [D.dob]);

  // Rx history for this patient — merge DB + in-session state, newest first
  const patientRxs = useMemo(() => {
    const byId = {};
    dbRxs.forEach(rx => { byId[rx.id] = rx; });
    Object.values(state.workspaces).forEach(ws => {
      if (ws.patientId !== patient.id) return;
      const rx = ws.rxPrescription;
      if (!rx?.rxNumber) return;
      byId[rx.id] = {
        id: rx.id,
        rxNumber: rx.rxNumber,
        status: rx.status,
        drugName: rx.techEntryData?.drugName || "",
        strength: rx.techEntryData?.strength || "",
        approvedAt: rx.rphReviewData?.decidedAt || null,
      };
    });
    return Object.values(byId).sort((a, b) => parseInt(b.rxNumber, 10) - parseInt(a.rxNumber, 10));
  }, [dbRxs, state.workspaces, patient.id]);

  const hasAllergies = D.allergies?.length > 0;
  const ins = D.insurance || {};

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", fontFamily: T.mono }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 14, padding: "14px 16px",
        background: color.light, borderBottom: `1px solid ${color.border}50`, flexShrink: 0,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: "50%", background: color.bg, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontSize: 18, fontWeight: 800, letterSpacing: -1,
        }}>
          {((D.firstName?.[0] || '') + (D.lastName?.[0] || '')).toUpperCase() || (D.name || "?")[0].toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: T.textPrimary, lineHeight: 1.2 }}>
            {D.firstName || D.lastName ? `${D.firstName || ""} ${D.lastName || ""}`.trim() : D.name}
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
            DOB: {D.dob}{age !== null ? ` · ${age} yrs` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {hasAllergies && !editMode && (
            <div style={{
              fontSize: 9, fontWeight: 800, color: "#e45858",
              background: "#e4585818", border: "1px solid #e4585840",
              padding: "3px 8px", borderRadius: 4, letterSpacing: 0.5,
            }}>⚠ ALLERGY</div>
          )}
          {editMode ? (
            <>
              <button onClick={cancelEdit} disabled={saving} style={{
                padding: "4px 10px", borderRadius: T.radiusSm, border: `1px solid ${T.surfaceBorder}`,
                background: T.surface, color: T.textMuted, cursor: "pointer", fontSize: 10, fontWeight: 600,
              }}>Cancel</button>
              <button onClick={handleSave} disabled={saving} style={{
                padding: "4px 12px", borderRadius: T.radiusSm, border: "none",
                background: color.bg, color: "#fff", cursor: saving ? "wait" : "pointer",
                fontSize: 10, fontWeight: 700,
              }}>{saving ? "Saving…" : "Save"}</button>
            </>
          ) : (
            <button onClick={startEdit} style={{
              padding: "4px 10px", borderRadius: T.radiusSm, border: `1px solid ${T.surfaceBorder}`,
              background: T.surface, color: T.textSecondary, cursor: "pointer", fontSize: 10, fontWeight: 600,
            }}>Edit</button>
          )}
        </div>
      </div>

      {/* Save error */}
      {saveError && (
        <div style={{ padding: "6px 16px", background: "#1f1418", borderBottom: "1px solid #e4585840", fontSize: 11, color: "#e45858" }}>
          {saveError}
        </div>
      )}

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>

        {/* Allergy banner (view mode) */}
        {hasAllergies && !editMode && (
          <div style={{
            marginBottom: 16, padding: "10px 14px", borderRadius: 8,
            background: "#1f1418", border: "1px solid #e4585840",
          }}>
            <div style={{ fontSize: 9, fontWeight: 800, color: "#e45858", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>
              ⚠ Allergies
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {D.allergies.map((a, i) => (
                <span key={i} style={{
                  fontSize: 11, fontWeight: 700, color: "#e45858",
                  background: "#e4585820", border: "1px solid #e4585850",
                  padding: "2px 8px", borderRadius: 4,
                }}>{a}</span>
              ))}
            </div>
          </div>
        )}

        {/* Demographics */}
        <ProfileSection title="Demographics">
          <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: "6px 12px", alignItems: "start" }}>
            <ProfileField label="First Name" value={D.firstName} onChange={e => setDraft(d => ({ ...d, firstName: e.target.value }))} editMode={editMode} />
            <ProfileField label="Last Name" value={D.lastName} onChange={e => setDraft(d => ({ ...d, lastName: e.target.value }))} editMode={editMode} />
            <ProfileFieldNormalized label="Date of Birth" value={D.dob} onChange={v => setDraft(d => ({ ...d, dob: v }))} onNormalize={normalizeDob} editMode={editMode} errorHint="e.g. 03/15/1985 or 03-15-85" />
            <ProfileFieldNormalized label="Phone" value={D.phone} onChange={v => setDraft(d => ({ ...d, phone: v }))} onNormalize={normalizePhone} editMode={editMode} errorHint="10-digit number required" />
            <ProfileAddressFields
              values={{ address1: D.address1, address2: D.address2, city: D.city, state: D.state, zip: D.zip }}
              onChange={(field, val) => setDraft(d => ({ ...d, [field]: val }))}
              editMode={editMode}
            />
          </div>
        </ProfileSection>

        {/* Allergies */}
        <ProfileSection title="Allergies">
          {editMode ? (
            <div>
              <input
                value={draft.allergies.join(", ")}
                onChange={e => setDraft(d => ({ ...d, allergies: e.target.value.split(",").map(s => s.trim()).filter(Boolean) }))}
                placeholder="Penicillin, Sulfa drugs, Latex…"
                style={PROFILE_INPUT_STYLE}
              />
              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4 }}>Comma-separated list</div>
            </div>
          ) : D.allergies.length === 0 ? (
            <span style={{ fontSize: 12, color: "#4abe6a", fontWeight: 600 }}>No known allergies</span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {D.allergies.map((a, i) => (
                <span key={i} style={{
                  fontSize: 11, fontWeight: 700, color: "#e45858",
                  background: "#e4585820", border: "1px solid #e4585850",
                  padding: "2px 8px", borderRadius: 4,
                }}>{a}</span>
              ))}
            </div>
          )}
        </ProfileSection>

        {/* Insurance */}
        <ProfileSection title="Insurance">
          <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: "6px 12px", alignItems: "start" }}>
            <ProfileField label="Plan" value={ins.plan} onChange={e => setDraft(d => ({ ...d, insurance: { ...d.insurance, plan: e.target.value } }))} editMode={editMode} />
            <ProfileField label="Member ID" value={ins.memberId} onChange={e => setDraft(d => ({ ...d, insurance: { ...d.insurance, memberId: e.target.value } }))} editMode={editMode} />
            <ProfileField label="Group" value={ins.group} onChange={e => setDraft(d => ({ ...d, insurance: { ...d.insurance, group: e.target.value } }))} editMode={editMode} />
            <ProfileField label="Copay" value={ins.copay} onChange={e => setDraft(d => ({ ...d, insurance: { ...d.insurance, copay: e.target.value } }))} editMode={editMode} />
          </div>
        </ProfileSection>

        {/* Rx History (from engine — never editable, always live) */}
        <ProfileSection title={`Rx History${patientRxs.length ? ` · ${patientRxs.length}` : ""}`}>
          {patientRxs.length === 0 ? (
            <div style={{ fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>
              No prescriptions on file yet
            </div>
          ) : patientRxs.map(rx => {
            const sc = RX_HISTORY_STATUS[rx.status] || { label: rx.status, color: T.textMuted };
            const dateStr = rx.approvedAt
              ? new Date(rx.approvedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" })
              : rx.updatedAt ? new Date(rx.updatedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : null;
            return (
              <div key={rx.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "7px 12px", marginBottom: 4, borderRadius: 6,
                background: T.surface, border: `1px solid ${T.surfaceBorder}`,
              }}>
                <div>
                  <span style={{ fontWeight: 800, fontSize: 11, color: color.bg, marginRight: 8 }}>{rx.rxNumber}</span>
                  <span style={{ fontSize: 12, color: T.textPrimary }}>{rx.drugName}{rx.strength ? ` ${rx.strength}` : ""}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {dateStr && <span style={{ fontSize: 10, color: T.textMuted }}>{dateStr}</span>}
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, color: sc.color, background: `${sc.color}18` }}>
                    {sc.label}
                  </span>
                </div>
              </div>
            );
          })}
        </ProfileSection>

        {/* Background Medications (read-only) */}
        {D.medications?.length > 0 && (
          <ProfileSection title={`Background Medications · ${D.medications.length}`}>
            {D.medications.map((med, i) => (
              <div key={i} style={{
                padding: "9px 12px", marginBottom: 6, borderRadius: 7,
                background: color.light, border: `1px solid ${color.border}30`,
              }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: T.textPrimary, marginBottom: 2 }}>{med.name}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>{med.directions}</div>
                <div style={{ display: "flex", gap: 12, fontSize: 10, color: T.textSecondary }}>
                  <span>Qty {med.qty}</span>
                  <span>Refills {med.refills}</span>
                  <span>Last fill {med.lastFill}</span>
                </div>
              </div>
            ))}
          </ProfileSection>
        )}

        {/* Notes */}
        <ProfileSection title="Notes">
          {editMode
            ? <textarea
                value={draft.notes}
                onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
                rows={4}
                placeholder="Pharmacy notes for this patient…"
                style={{ ...PROFILE_INPUT_STYLE, resize: "vertical", lineHeight: 1.5 }}
              />
            : <div style={{
                padding: "10px 14px", borderRadius: 8,
                background: T.surface, border: `1px solid ${T.surfaceBorder}`,
                fontSize: 12, color: D.notes ? T.textSecondary : T.textMuted,
                lineHeight: 1.6, whiteSpace: "pre-wrap",
                fontStyle: D.notes ? "normal" : "italic",
              }}>
                {D.notes || "No notes."}
              </div>
          }
        </ProfileSection>

      </div>
    </div>
  );
}

function MedHistoryContent({ patient, workspace }) {
  const data = useDataProvider();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!patient?.id) return;
    setLoading(true);
    data.getFillHistory(patient.id)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [patient?.id, data]);

  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13, overflowY: 'auto', height: '100%' }}>
      <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>
        Fill History ({loading ? '…' : history.length})
      </div>
      {!loading && history.length === 0 && (
        <div style={{ color: T.textMuted, fontSize: 12 }}>No fill history on file.</div>
      )}
      {history.map((h) => (
        <div key={h.id} style={{
          padding: "10px 14px", marginBottom: 8, borderRadius: 8,
          background: workspace?.color?.light || T.surface,
          border: `1px solid ${T.surfaceBorder}`,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>
            {h.drugName}{h.strength ? ` ${h.strength}` : ''}{h.form ? ` · ${h.form}` : ''}
          </div>
          <div style={{ fontSize: 11, color: T.textSecondary, display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 2 }}>
            {h.rxNumber && <span>Rx# {h.rxNumber}</span>}
            {h.qtyDispensed != null && <span>Qty: {h.qtyDispensed}</span>}
            {h.daysSupply != null && <span>DS: {h.daysSupply}d</span>}
            {h.ndc && <span>NDC: {h.ndc}</span>}
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, display: "flex", gap: 12 }}>
            {h.prescriberName && <span>{h.prescriberName}</span>}
            <span>{new Date(h.dispensedAt).toLocaleDateString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function InsuranceContent({ patient, workspace }) {
  const ins = patient.insurance;
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      <div style={{
        padding: 16, borderRadius: 8, background: workspace.color.light,
        border: `1px solid ${workspace.color.border}40`,
      }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>{ins.plan}</div>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "6px 12px" }}>
          <span style={{ color: T.textMuted, fontWeight: 600 }}>Member ID</span>
          <span style={{ fontFamily: T.mono }}>{ins.memberId}</span>
          <span style={{ color: T.textMuted, fontWeight: 600 }}>Group</span>
          <span>{ins.group}</span>
          <span style={{ color: T.textMuted, fontWeight: 600 }}>Copay</span>
          <span>{ins.copay}</span>
        </div>
      </div>
    </div>
  );
}

function AllergiesContent({ patient, workspace }) {
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      {!patient.allergies?.length ? (
        <div style={{ color: "#4abe6a", fontWeight: 600 }}>No known allergies</div>
      ) : (
        patient.allergies.map((a, i) => (
          <div key={i} style={{
            padding: "10px 14px", marginBottom: 8, borderRadius: 8,
            background: "#1f1418", border: "1px solid #3d2228",
            color: "#e45858", fontWeight: 600, display: "flex", alignItems: "center", gap: 8,
          }}>
            {a}
          </div>
        ))
      )}
    </div>
  );
}

function NotesContent({ patient }) {
  return (
    <div style={{ padding: 16, fontFamily: T.mono, fontSize: 13 }}>
      <div style={{
        padding: 14, borderRadius: 8, background: T.surface,
        border: `1px solid ${T.surfaceBorder}`, lineHeight: 1.6,
        minHeight: 100, whiteSpace: "pre-wrap",
      }}>
        {patient.notes || "No notes for this patient."}
      </div>
    </div>
  );
}

// ============================================================
// RX HISTORY
// ============================================================
const RX_HISTORY_STATUS = {
  incoming:            { label: "Incoming",    color: "#64748b" },
  in_entry:            { label: "Entry",       color: "#94a3b8" },
  pending_review:      { label: "RPh Review",  color: "#5b8af5" },
  returned:            { label: "Returned",    color: "#e8a030" },
  call_prescriber:     { label: "Call Dr",     color: "#e45858" },
  approved:            { label: "Approved",    color: "#4abe6a" },
  in_fill:             { label: "Filling",     color: "#40c0b0" },
  pending_fill_verify: { label: "Fill Check",  color: "#e8a030" },
  ready:               { label: "Ready",       color: "#4abe6a" },
  sold:                { label: "Sold",        color: "#64748b" },
};

// ============================================================
// PICKUP WORKSPACE
// ============================================================
function PickupContent({ workspace }) {
  const data = useDataProvider();
  const { state, dispatch, currentUser } = useContext(PharmIDEContext);
  const { getEntities } = useData();
  const color = workspace.color;

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [results, setResults] = useState(null); // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [soldIds, setSoldIds] = useState(new Set());

  const canSearch = firstName.trim().length >= 3 && lastName.trim().length >= 3;

  const handleSearch = async () => {
    setSearching(true);
    setResults(null);

    const fnQ = firstName.trim().toLowerCase();
    const lnQ = lastName.trim().toLowerCase();
    const dobQ = dob.trim();

    // Match patients from store by name prefix + optional DOB
    const allPatients = getEntities('patient');
    const matched = allPatients.filter(p => {
      const parts = (p.name || "").toLowerCase().split(/\s+/);
      const fn = parts[0] || "";
      const ln = parts[parts.length - 1] || "";
      const nameMatch = fn.startsWith(fnQ) && ln.startsWith(lnQ);
      const dobMatch = !dobQ || p.dob === dobQ;
      return nameMatch && dobMatch;
    });

    const patientIds = new Set(matched.map(p => p.id));

    // Collect ready prescriptions — current session workspaces first
    const found = {};
    Object.values(state.workspaces).forEach(ws => {
      const rx = ws.rxPrescription;
      if (rx?.status === "ready" && patientIds.has(ws.patientId)) {
        const patient = matched.find(p => p.id === ws.patientId);
        found[rx.id] = { rx, patient };
      }
    });

    // Then DB (fills in ready prescriptions from previous sessions)
    try {
      const dbRxs = await data.getPrescriptionsByStatus("ready");
      dbRxs.forEach(rx => {
        if (!found[rx.id] && patientIds.has(rx.patientId)) {
          const patient = matched.find(p => p.id === rx.patientId);
          if (patient) found[rx.id] = { rx, patient };
        }
      });
    } catch (_) {}

    setResults(Object.values(found));
    setSearching(false);
  };

  const handleSell = async (rx, patient) => {
    const actorId = currentUser?.id || "usr-tech-1";
    const actorRole = currentUser?.role || "tech";

    await data.sellPrescription(rx.id, actorId, actorRole);

    // Fire-and-forget — sell completes regardless of fill history write
    const te = rx.techEntryData || {};
    const fd = rx.fillData || {};
    const prescriberObj = te.prescriber || {};
    const prescriberName = prescriberObj.lastName
      ? `${prescriberObj.firstName || ''} ${prescriberObj.lastName}`.trim()
      : (typeof te.prescriber === 'string' ? te.prescriber : null);
    data.appendFillHistory({
      id: crypto.randomUUID(),
      patientId: rx.patientId,
      rxId: rx.id,
      rxNumber: rx.rxNumber || null,
      ndc: fd.scannedNdc || null,
      drugName: te.drugName || te.drug?.name || 'Unknown',
      strength: te.strength || null,
      form: te.form || null,
      labeler: te._product?.labeler || te.product?.labeler || null,
      qtyDispensed: fd.confirmedQty ?? te.qty ?? null,
      daysSupply: te.daysSupply ?? null,
      prescriberName,
      prescriberDea: prescriberObj.dea || null,
      dispensedAt: new Date().toISOString(),
      dispensedBy: actorId,
      lotNumber: null,
    });

    // Update workspace state if this prescription is open in a tile
    dispatch({ type: "SELL_RX", rxId: rx.id });

    // Mark sold in this session's results view
    setSoldIds(prev => new Set([...prev, rx.id]));
  };

  const inputStyle = {
    background: T.surface, border: `1px solid ${T.surfaceBorder}`, borderRadius: T.radiusSm,
    color: T.textPrimary, fontSize: 12, padding: "6px 10px", fontFamily: T.mono,
    outline: "none", width: "100%", boxSizing: "border-box",
  };

  return (
    <div style={{ padding: 16, fontFamily: T.sans, height: "100%", display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Search bar */}
      <div style={{ background: T.surface, border: `1px solid ${T.surfaceBorder}`, borderRadius: T.radius, padding: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: color.bg, marginBottom: 12 }}>
          Prescription Pickup
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <div>
            <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>First Name <span style={{ color: T.textMuted }}>(min 3)</span></div>
            <input
              style={inputStyle}
              placeholder="e.g. Mar"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && canSearch && handleSearch()}
            />
          </div>
          <div>
            <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Last Name <span style={{ color: T.textMuted }}>(min 3)</span></div>
            <input
              style={inputStyle}
              placeholder="e.g. Joh"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && canSearch && handleSearch()}
            />
          </div>
          <div>
            <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>Date of Birth</div>
            <input
              style={inputStyle}
              placeholder="MM/DD/YYYY"
              value={dob}
              onChange={e => setDob(e.target.value)}
              onKeyDown={e => e.key === "Enter" && canSearch && handleSearch()}
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={!canSearch || searching}
            style={{
              padding: "6px 16px", borderRadius: T.radiusSm, border: "none", cursor: canSearch ? "pointer" : "not-allowed",
              background: canSearch ? color.bg : T.surfaceBorder, color: canSearch ? "#fff" : T.textMuted,
              fontSize: 12, fontWeight: 700, fontFamily: T.mono, opacity: searching ? 0.6 : 1,
              transition: "background 0.15s",
            }}
          >
            {searching ? "…" : "Search"}
          </button>
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {results === null && (
          <div style={{ textAlign: "center", color: T.textMuted, fontSize: 12, marginTop: 40, fontFamily: T.mono }}>
            Enter first and last name to search for ready prescriptions.
          </div>
        )}
        {results !== null && results.length === 0 && (
          <div style={{ textAlign: "center", color: T.textMuted, fontSize: 12, marginTop: 40, fontFamily: T.mono }}>
            No ready prescriptions found for that patient.
          </div>
        )}
        {results !== null && results.map(({ rx, patient }) => {
          const alreadySold = soldIds.has(rx.id);
          const tech = typeof rx.techEntryData === 'string'
            ? JSON.parse(rx.techEntryData || '{}')
            : (rx.techEntryData || {});
          const drugName = tech.drugName || "Unknown Drug";
          const strength = tech.strength || "";
          return (
            <div key={rx.id} style={{
              background: alreadySold ? T.surface : T.surfaceRaised,
              border: `1px solid ${alreadySold ? T.surfaceBorder : color.bg}30`,
              borderRadius: T.radius, padding: "14px 16px", marginBottom: 10,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              opacity: alreadySold ? 0.5 : 1, transition: "opacity 0.3s",
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: T.textPrimary, marginBottom: 4 }}>
                  {patient.name}
                </div>
                <div style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono, display: "flex", gap: 12 }}>
                  <span>DOB: {patient.dob}</span>
                  {rx.rxNumber && <span style={{ color: color.bg }}>Rx# {rx.rxNumber}</span>}
                </div>
                <div style={{ fontSize: 12, color: T.textSecondary, marginTop: 6 }}>
                  {drugName}{strength ? ` ${strength}` : ""}
                </div>
              </div>
              {alreadySold ? (
                <span style={{
                  fontSize: 11, fontFamily: T.mono, fontWeight: 700, color: "#64748b",
                  background: "#64748b18", border: "1px solid #64748b30",
                  borderRadius: T.radiusSm, padding: "4px 12px",
                }}>
                  SOLD
                </span>
              ) : (
                <button
                  onClick={() => handleSell(rx, patient)}
                  style={{
                    padding: "8px 20px", borderRadius: T.radiusSm, border: "none", cursor: "pointer",
                    background: color.bg, color: "#fff", fontSize: 13, fontWeight: 700,
                    fontFamily: T.mono, letterSpacing: 0.5, flexShrink: 0,
                  }}
                >
                  Sell
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RxHistoryContent({ workspace }) {
  const data = useDataProvider();
  const { state } = useContext(PharmIDEContext);
  const { getEntity, getEntities, getPrescriberById } = useData();
  const color = workspace.color;

  const [search, setSearch] = useState("");
  const [dbRxs, setDbRxs] = useState([]);

  // Load historical records from DB on mount (past sessions not yet in store)
  useEffect(() => {
    data.getAllPrescriptions().then(list => { if (list?.length) setDbRxs(list); });
  }, []);

  // Build list: merge store prescriptions (live) + DB records (historical) + in-session
  // workspaces (for eOrder field and other workspace-only fields), deduped by id.
  const allRxs = useMemo(() => {
    const storePrescriptions = getEntities('prescription');
    const parse = (v) => {
      if (!v) return {};
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
      return v;
    };
    const byId = {};

    // DB records first — supplement for historical prescriptions not yet in store
    dbRxs.forEach(rx => {
      const tech = parse(rx.techEntryData);
      const rph = parse(rx.rphReviewData);
      const patient = getEntity('patient', rx.patientId);
      byId[rx.id] = {
        id: rx.id,
        rxNumber: rx.rxNumber,
        patientId: rx.patientId,
        patientName: patient?.name || rx.patientId || "",
        status: rx.status,
        drugName: tech.drugName || "",
        strength: tech.strength || "",
        prescriberName: tech.prescriberName || "",
        prescriberId: tech.prescriberId || null,
        approvedAt: rph.decidedAt || null,
        scheduleClass: rx.scheduleClass || null,
      };
    });

    // Store prescriptions override DB records — these are kept live by syncRxToStore
    storePrescriptions.forEach(rx => {
      if (!rx.id) return;
      const patient = getEntity('patient', rx.patientId);
      byId[rx.id] = {
        id: rx.id,
        rxNumber: rx.rxNumber,
        patientId: rx.patientId,
        patientName: patient?.name || rx.patientId || "",
        status: rx.status,
        drugName: rx.techEntryData?.drugName || "",
        strength: rx.techEntryData?.strength || "",
        prescriberName: rx.techEntryData?.prescriberName || "",
        prescriberId: rx.techEntryData?.prescriberId || null,
        approvedAt: rx.rphReviewData?.decidedAt || null,
        scheduleClass: rx.scheduleClass || null,
      };
    });

    // In-session workspace overlay — catches workspaces not yet flushed to store
    Object.values(state.workspaces).forEach(ws => {
      const rx = ws.rxPrescription;
      if (!rx?.id) return;
      const patient = getEntity('patient', ws.patientId);
      // Only override if workspace has newer data (has techEntryData set)
      if (rx.techEntryData || !byId[rx.id]) {
        byId[rx.id] = {
          id: rx.id,
          rxNumber: rx.rxNumber,
          patientId: ws.patientId,
          patientName: patient?.name || ws.patientId || "",
          status: rx.status,
          drugName: rx.techEntryData?.drugName || byId[rx.id]?.drugName || "",
          strength: rx.techEntryData?.strength || byId[rx.id]?.strength || "",
          prescriberName: rx.techEntryData?.prescriberName || byId[rx.id]?.prescriberName || "",
          prescriberId: rx.techEntryData?.prescriberId || byId[rx.id]?.prescriberId || null,
          approvedAt: rx.rphReviewData?.decidedAt || byId[rx.id]?.approvedAt || null,
          scheduleClass: rx.scheduleClass || byId[rx.id]?.scheduleClass || null,
        };
      }
    });

    // Sort numerically by rx number (null Rx# sorts last)
    return Object.values(byId)
      .filter(rx => rx.rxNumber)
      .sort((a, b) => parseInt(a.rxNumber, 10) - parseInt(b.rxNumber, 10));
  }, [dbRxs, getEntities, state.workspaces, getEntity]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allRxs;
    const q = search.toLowerCase();
    return allRxs.filter(rx =>
      rx.rxNumber?.includes(q) ||
      rx.patientName?.toLowerCase().includes(q) ||
      rx.drugName?.toLowerCase().includes(q) ||
      rx.prescriberName?.toLowerCase().includes(q)
    );
  }, [allRxs, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: T.bg, fontFamily: T.mono }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px", borderBottom: `1px solid ${T.surfaceBorder}`,
        display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: color.bg, textTransform: "uppercase", letterSpacing: 1 }}>
            Rx History
          </div>
          <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>
            {allRxs.length} prescription{allRxs.length !== 1 ? "s" : ""} · sorted by Rx#
          </div>
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search Rx#, patient, drug…"
          style={{
            background: T.surface, border: `1px solid ${T.surfaceBorder}`,
            borderRadius: T.radiusSm, color: T.textPrimary,
            fontSize: 11, padding: "5px 10px", outline: "none", width: 200,
            fontFamily: T.mono,
          }}
        />
      </div>

      {/* Column headers */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "80px 1fr 1fr 1fr 110px 110px",
        padding: "6px 16px", borderBottom: `1px solid ${T.surfaceBorder}`,
        fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1,
        color: T.textMuted, flexShrink: 0,
      }}>
        <span>Rx#</span>
        <span>Patient</span>
        <span>Drug</span>
        <span>Prescriber</span>
        <span>Status</span>
        <span>Approved</span>
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontSize: 12 }}>
            {search ? "No matches" : "No prescriptions yet — Rx numbers are assigned at RPh approval"}
          </div>
        ) : filtered.map((rx, i) => {
          const sc = RX_HISTORY_STATUS[rx.status] || { label: rx.status, color: T.textMuted };
          const approvedStr = rx.approvedAt
            ? new Date(rx.approvedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" })
            : "—";
          const rowBase = i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.025)";
          return (
            <div key={rx.id} style={{
              display: "grid",
              gridTemplateColumns: "80px 1fr 1fr 1fr 110px 110px",
              padding: "9px 16px",
              alignItems: "center",
              fontSize: 11,
              color: T.textPrimary,
              background: rowBase,
            }}
            onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.055)"}
            onMouseOut={e => e.currentTarget.style.background = rowBase}
            >
              <span style={{ fontWeight: 800, color: color.bg, fontFamily: T.mono }}>
                {rx.rxNumber}
              </span>
              <span style={{ color: T.textPrimary }}>{rx.patientName || rx.patientId}</span>
              <span style={{ color: T.textPrimary }}>
                {rx.drugName}{rx.strength ? ` ${rx.strength}` : ""}
              </span>
              <span style={{ color: T.textSecondary, display: 'flex', alignItems: 'center', gap: 4 }}>
                {rx.prescriberName || "—"}
                {rx.prescriberId && getPrescriberById(rx.prescriberId)?.formerLastName && (
                  <span style={{
                    fontSize: 8, background: '#f59e0b20', color: '#f59e0b',
                    border: '1px solid #f59e0b40', borderRadius: 3, padding: '1px 4px',
                    fontWeight: 700, whiteSpace: 'nowrap',
                  }}>
                    Name changed
                  </span>
                )}
              </span>
              <span>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                  color: sc.color, background: `${sc.color}18`,
                }}>
                  {sc.label}
                </span>
              </span>
              <span style={{ color: T.textMuted, fontSize: 10 }}>{approvedStr}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ============================================================
// DRUG BROWSER — Full-scroll product-level drug search tile
// ============================================================
function DrugSearchContent({ workspace }) {
  const data = useDataProvider();
  const { dispatch } = useContext(PharmIDEContext);
  const color = workspace.color;

  const [query, setQuery] = useState(workspace.drugSearchInitialQuery || "");
  const [drugs, setDrugs] = useState([]);
  const [loadingDrugs, setLoadingDrugs] = useState(false);
  const [selectedDrug, setSelectedDrug] = useState(null);
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [inventoryMap, setInventoryMap] = useState({});
  const inputRef = useRef(null);

  // Search drugs — 200ms debounce, 2-char min, 50 results
  useEffect(() => {
    if (!query || query.trim().length < 2) {
      setDrugs([]);
      setSelectedDrug(null);
      return;
    }
    let cancelled = false;
    setLoadingDrugs(true);
    const timer = setTimeout(() => {
      Promise.resolve(data.searchDrugs(query, 50)).then(results => {
        if (cancelled) return;
        setDrugs(results || []);
        setLoadingDrugs(false);
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, data]);

  // Load products + inventory when drug is selected
  useEffect(() => {
    if (!selectedDrug) { setProducts([]); setInventoryMap({}); return; }
    setSelectedProduct(null);
    setLoadingProducts(true);
    Promise.resolve(data.getProductsForDrug(selectedDrug.id, selectedDrug._matchedStrength)).then(async ps => {
      const list = ps || [];
      setProducts(list);
      setLoadingProducts(false);
      if (list.length) {
        const ndcs = list.map(p => p.ndc).filter(Boolean);
        try {
          const records = await Promise.resolve(data.getInventoryBatch(ndcs));
          const map = {};
          (records || []).forEach(r => { map[r.ndcCode] = r.onHand; });
          setInventoryMap(map);
        } catch (_) { /* non-fatal */ }
      }
    });
  }, [selectedDrug, data]);

  const handleApply = () => {
    if (!selectedDrug || !selectedProduct) return;
    dispatch({ type: "DRUG_SEARCH_SELECT", workspaceId: workspace.id, drug: selectedDrug, product: selectedProduct });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: T.surfaceBase, overflow: "hidden" }}>

      {/* ── Search bar ── */}
      <div style={{ padding: "12px 14px 10px", borderBottom: `1px solid ${T.surfaceBorder}`, flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>
          Drug Browser
        </div>
        <div style={{ position: "relative" }}>
          <svg style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: T.textMuted, pointerEvents: "none" }}
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
            placeholder="name or name,strength,form …"
            style={{
              width: "100%", padding: "7px 10px 7px 28px", borderRadius: 6, boxSizing: "border-box",
              border: `1px solid ${T.inputBorder}`, background: T.surfaceRaised,
              color: T.textPrimary, fontSize: 13, fontFamily: T.mono, outline: "none",
            }}
          />
        </div>
      </div>

      {/* ── Two-panel body ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Left — drug results */}
        <div style={{ width: "42%", borderRight: `1px solid ${T.surfaceBorder}`, overflowY: "auto", flexShrink: 0 }}>
          {loadingDrugs && (
            <div style={{ padding: "16px 14px", color: T.textMuted, fontSize: 12 }}>Searching…</div>
          )}
          {!loadingDrugs && drugs.length === 0 && query.trim().length >= 2 && (
            <div style={{ padding: "16px 14px", color: T.textMuted, fontSize: 12 }}>No results</div>
          )}
          {!loadingDrugs && query.trim().length < 2 && (
            <div style={{ padding: "16px 14px", color: T.textMuted, fontSize: 12 }}>Type to search…</div>
          )}
          {drugs.map(d => {
            const hl = selectedDrug?.id === d.id;
            return (
              <div
                key={d.id}
                onClick={() => setSelectedDrug(d)}
                style={{
                  padding: "9px 12px", cursor: "pointer",
                  background: hl ? color.light : "transparent",
                  borderBottom: `1px solid ${T.surfaceBorder}`,
                  borderLeft: hl ? `3px solid ${color.bg}` : "3px solid transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, fontFamily: T.mono, color: T.textPrimary }}>{d.name}</span>
                  {["C-II", "C-III", "C-IV", "C-V"].includes(d.schedule) && (
                    <span style={{ fontSize: 9, fontWeight: 800, color: "#e8a030", background: "#1f1a14", border: "1px solid #3d3020", padding: "1px 5px", borderRadius: 3, flexShrink: 0 }}>
                      {d.schedule}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: hl ? T.textSecondary : T.textMuted, marginTop: 2, fontFamily: T.mono }}>
                  {d._matchedStrength}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right — products for selected drug */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {!selectedDrug && (
            <div style={{ padding: "16px 14px", color: T.textMuted, fontSize: 12 }}>
              Select a drug to see available NDCs
            </div>
          )}
          {selectedDrug && loadingProducts && (
            <div style={{ padding: "16px 14px", color: T.textMuted, fontSize: 12 }}>Loading products…</div>
          )}
          {selectedDrug && !loadingProducts && products.length === 0 && (
            <div style={{ padding: "16px 14px", color: T.textMuted, fontSize: 12 }}>No dispensable products found</div>
          )}
          {selectedDrug && !loadingProducts && products.map(p => {
            const hl = selectedProduct?.id === p.id;
            const oh = inventoryMap[p.ndc];
            const low = oh != null && oh <= 20;
            return (
              <div
                key={p.id}
                onClick={() => setSelectedProduct(hl ? null : p)}
                style={{
                  padding: "9px 14px", cursor: "pointer",
                  background: hl ? color.light : "transparent",
                  borderBottom: `1px solid ${T.surfaceBorder}`,
                  borderLeft: hl ? `3px solid ${color.bg}` : "3px solid transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.textPrimary, letterSpacing: "0.04em" }}>{p.ndc}</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    {p.packSize > 0 && (
                      <span style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono }}>{p.packSize} {p.packUnit}</span>
                    )}
                    {oh != null && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, fontFamily: T.mono,
                        color: low ? "#e8a030" : "#4abe6a",
                        background: low ? "#1f1a14" : "#162018",
                        border: `1px solid ${low ? "#3d3020" : "#1a3d22"}`,
                        padding: "1px 6px", borderRadius: 3,
                      }}>
                        {oh} on hand
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 2, fontFamily: T.mono }}>{p.description}</div>
                {p.manufacturer && (
                  <div style={{ fontSize: 10, color: T.textMuted, marginTop: 1 }}>{p.manufacturer}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Footer action bar ── */}
      {selectedProduct && selectedDrug && (
        <div style={{
          padding: "10px 14px", borderTop: `1px solid ${T.surfaceBorder}`,
          background: color.light, display: "flex", alignItems: "center", justifyContent: "space-between",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 12, fontFamily: T.mono, color: T.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, marginRight: 12 }}>
            <span style={{ fontWeight: 700, color: T.textPrimary }}>{selectedDrug.name}</span>
            <span style={{ color: T.textMuted, margin: "0 6px" }}>·</span>
            {selectedDrug._matchedStrength}
            <span style={{ color: T.textMuted, margin: "0 6px" }}>·</span>
            {selectedProduct.ndc}
          </div>
          <button
            onClick={handleApply}
            style={{
              padding: "6px 18px", borderRadius: 6, border: "none", cursor: "pointer",
              background: color.bg, color: "#fff", fontWeight: 700, fontSize: 13,
              fontFamily: T.mono, flexShrink: 0,
            }}
          >
            Apply to Rx
          </button>
        </div>
      )}
    </div>
  );
}


// ============================================================
// PRESCRIBER DIRECTORY CONTENT
// ============================================================
function PrescriberDirectoryContent({ workspace }) {
  const { store, updateEntity, searchPrescribers } = useData();
  const color = workspace.color;

  const allPrescribers = Object.values(store.prescribers)
    .sort((a, b) => (a.lastName || '').localeCompare(b.lastName || ''));

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(false);

  const displayList = searchQuery.length >= 2
    ? searchPrescribers(searchQuery)
    : allPrescribers;

  const selected = selectedId ? (store.prescribers[selectedId] || null) : null;

  function startEdit(prescriber) {
    setDraft({ ...prescriber });
    setEditing(true);
    setIsNew(false);
  }

  function startNew() {
    setDraft({
      id: `pres-${Date.now()}`,
      firstName: '', lastName: '', formerLastName: null, nameChangedAt: null,
      credentials: '', dea: '', npi: '', practice: '',
      phone: '', fax: '', address: '', specialty: '', notes: '',
    });
    setSelectedId(null);
    setEditing(true);
    setIsNew(true);
  }

  async function handleSave() {
    if (!draft?.id) return;
    setSaving(true);
    try {
      await updateEntity('prescriber', draft.id, draft);
      setSelectedId(draft.id);
      setEditing(false);
      setIsNew(false);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setEditing(false);
    setIsNew(false);
    setDraft(null);
  }

  function field(label, key, opts = {}) {
    const val = draft?.[key] ?? '';
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: T.textSecondary, fontWeight: 600, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {label}
        </div>
        {opts.multiline ? (
          <textarea
            value={val}
            onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
            rows={opts.rows || 3}
            style={{
              width: '100%', padding: '7px 10px', borderRadius: T.radiusSm,
              border: `1px solid ${T.inputBorder}`, background: T.inputBg,
              color: T.textPrimary, fontSize: 13, fontFamily: T.sans,
              resize: 'vertical', boxSizing: 'border-box', outline: 'none',
            }}
          />
        ) : (
          <input
            type="text"
            value={val}
            onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
            style={{
              width: '100%', padding: '7px 10px', borderRadius: T.radiusSm,
              border: `1px solid ${T.inputBorder}`, background: T.inputBg,
              color: T.textPrimary, fontSize: 13, fontFamily: T.sans,
              boxSizing: 'border-box', outline: 'none',
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: T.bg }}>
      {/* Left panel — list */}
      <div style={{
        width: 280, flexShrink: 0, borderRight: `1px solid ${T.surfaceBorder}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Search + New */}
        <div style={{ padding: '10px 10px 8px', borderBottom: `1px solid ${T.surfaceBorder}`, display: 'flex', gap: 6 }}>
          <input
            type="text"
            placeholder="Search prescribers..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              flex: 1, padding: '6px 10px', borderRadius: T.radiusSm,
              border: `1px solid ${T.inputBorder}`, background: T.inputBg,
              color: T.textPrimary, fontSize: 12, fontFamily: T.sans, outline: 'none',
            }}
          />
          <button
            onClick={startNew}
            style={{
              padding: '6px 10px', borderRadius: T.radiusSm, border: 'none',
              background: color.bg, color: '#fff', fontWeight: 700,
              fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            + New
          </button>
        </div>
        {/* Prescriber list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {displayList.length === 0 && (
            <div style={{ padding: 16, color: T.textMuted, fontSize: 12, textAlign: 'center' }}>
              {searchQuery.length >= 2 ? 'No results' : 'No prescribers on file'}
            </div>
          )}
          {displayList.map(p => (
            <div
              key={p.id}
              onClick={() => { setSelectedId(p.id); setEditing(false); setDraft(null); }}
              style={{
                padding: '9px 12px', borderBottom: `1px solid ${T.surfaceBorder}`,
                cursor: 'pointer', background: selectedId === p.id ? T.surfaceHover : 'transparent',
                transition: 'background 0.1s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: T.textPrimary }}>
                  {p.lastName}, {p.firstName}
                </span>
                {p.credentials && (
                  <span style={{ fontSize: 10, color: color.bg, fontFamily: T.mono, fontWeight: 600 }}>
                    {p.credentials}
                  </span>
                )}
                {p.formerLastName && (
                  <span style={{
                    fontSize: 9, background: '#f59e0b20', color: '#f59e0b',
                    border: '1px solid #f59e0b40', borderRadius: 4, padding: '1px 5px',
                    fontWeight: 600,
                  }}>
                    Name changed
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: T.textSecondary, marginTop: 2 }}>
                {p.practice || '—'}
              </div>
              {p.dea && (
                <div style={{ fontSize: 10, color: T.textMuted, marginTop: 1, fontFamily: T.mono }}>
                  DEA: {p.dea}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — detail / edit form */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {!editing && !selected && !isNew && (
          <div style={{ color: T.textMuted, fontSize: 13, textAlign: 'center', marginTop: 60 }}>
            Select a prescriber to view details, or click + New
          </div>
        )}

        {!editing && selected && (
          <div>
            {/* Name change banner */}
            {selected.formerLastName && (
              <div style={{
                background: '#fef3c720', border: '1px solid #f59e0b60', borderRadius: 8,
                padding: '8px 12px', marginBottom: 16, fontSize: 12, color: '#f59e0b',
              }}>
                Legal name changed from <strong>{selected.formerLastName}</strong>
                {selected.nameChangedAt ? ` on ${selected.nameChangedAt.slice(0, 10)}` : ''}.
                Prescriptions filed before this date are linked to the former name.
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800, color: T.textPrimary }}>
                  Dr. {selected.firstName} {selected.lastName}{selected.credentials ? `, ${selected.credentials}` : ''}
                </div>
                <div style={{ fontSize: 13, color: T.textSecondary, marginTop: 2 }}>{selected.practice || ''}</div>
              </div>
              <button
                onClick={() => startEdit(selected)}
                style={{
                  padding: '6px 14px', borderRadius: T.radiusSm, border: `1px solid ${color.bg}40`,
                  background: `${color.bg}15`, color: color.bg, cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                }}
              >
                Edit
              </button>
            </div>
            {[
              ['DEA', selected.dea], ['NPI', selected.npi],
              ['Phone', selected.phone], ['Fax', selected.fax],
              ['Address', selected.address], ['Specialty', selected.specialty],
            ].filter(([, v]) => v).map(([label, val]) => (
              <div key={label} style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                <span style={{ width: 70, fontSize: 12, color: T.textSecondary, fontWeight: 600, flexShrink: 0 }}>{label}</span>
                <span style={{ fontSize: 13, color: T.textPrimary, fontFamily: label === 'DEA' || label === 'NPI' ? T.mono : T.sans }}>{val}</span>
              </div>
            ))}
            {selected.notes && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: T.surface, borderRadius: T.radiusSm, fontSize: 12, color: T.textSecondary }}>
                {selected.notes}
              </div>
            )}
          </div>
        )}

        {editing && draft && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.textPrimary, marginBottom: 16 }}>
              {isNew ? 'New Prescriber' : `Edit — ${draft.firstName} ${draft.lastName}`}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              {field('First Name', 'firstName')}
              {field('Last Name', 'lastName')}
              {field('Credentials', 'credentials')}
              {field('Specialty', 'specialty')}
              {field('DEA Number', 'dea')}
              {field('NPI', 'npi')}
              {field('Practice / Clinic', 'practice')}
              {field('Phone', 'phone')}
              {field('Fax', 'fax')}
              {field('Address', 'address')}
            </div>
            {draft.formerLastName && (
              <div style={{
                background: '#fef3c720', border: '1px solid #f59e0b60', borderRadius: 8,
                padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#f59e0b',
              }}>
                Former last name on file: <strong>{draft.formerLastName}</strong>.
                All Rxs linked to this prescriber will display a name-change notice.
              </div>
            )}
            {field('Notes', 'notes', { multiline: true, rows: 3 })}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: '8px 20px', borderRadius: T.radiusSm, border: 'none',
                  background: color.bg, color: '#fff', fontWeight: 700, fontSize: 13,
                  cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={handleCancel}
                style={{
                  padding: '8px 16px', borderRadius: T.radiusSm, border: `1px solid ${T.surfaceBorder}`,
                  background: 'transparent', color: T.textSecondary, cursor: 'pointer', fontSize: 13,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PRESCRIBER CARD CONTENT (in-patient tile)
// ============================================================
function PatientMaintenanceContent({ workspace }) {
  const data = useDataProvider();
  const { getEntities, storeDispatch } = useData();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const color = workspace.color;

  useEffect(() => {
    data.getAllPatients().then(rows => {
      if (!rows?.length) return;
      rows.forEach(row => {
        storeDispatch({ type: 'ENTITY_UPDATED', entityType: 'patient', entityId: row.id, data: parsePatientRow(row) });
      });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const allPatients = getEntities('patient');

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const list = q
      ? allPatients.filter(p =>
          `${p.name} ${p.firstName} ${p.lastName} ${p.dob || ''} ${p.phone || ''}`.toLowerCase().includes(q))
      : allPatients;
    return [...list].sort((a, b) =>
      (a.lastName || a.name || '').localeCompare(b.lastName || b.name || ''));
  }, [allPatients, query]);

  const selectedPatient = selectedId ? allPatients.find(p => p.id === selectedId) || null : null;

  const syntheticWs = useMemo(() => selectedPatient ? {
    id: `maintenance-${selectedPatient.id}`,
    color,
    patientId: selectedPatient.id,
    rxPrescription: null,
    tabs: [],
  } : null, [selectedPatient?.id, color]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden" }}>

      {/* Left: search + list */}
      <div style={{
        width: 260, flexShrink: 0, display: "flex", flexDirection: "column",
        borderRight: `1px solid ${T.surfaceBorder}`, background: T.surface,
      }}>
        <div style={{ padding: "10px 10px 8px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search patients…"
            style={{
              width: "100%", boxSizing: "border-box",
              background: T.inputBg, border: `1px solid ${T.inputBorder}`,
              borderRadius: T.radiusSm, color: T.inputText, fontSize: 12,
              padding: "5px 9px", outline: "none", fontFamily: T.mono,
            }}
          />
        </div>
        <div style={{
          fontSize: 9, fontWeight: 800, letterSpacing: 1.5, textTransform: "uppercase",
          color: T.textMuted, padding: "6px 12px 3px",
        }}>
          {filtered.length} patient{filtered.length !== 1 ? "s" : ""}
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.map(p => {
            const isSelected = p.id === selectedId;
            const displayName = p.lastName && p.firstName
              ? `${p.lastName}, ${p.firstName}`
              : p.name || p.id;
            return (
              <button key={p.id} onClick={() => setSelectedId(p.id)} style={{
                width: "100%", padding: "9px 12px", display: "flex", flexDirection: "column",
                alignItems: "flex-start", textAlign: "left",
                background: isSelected ? `${color.bg}18` : "transparent",
                border: "none",
                borderLeft: `3px solid ${isSelected ? color.bg : "transparent"}`,
                cursor: "pointer", transition: "background 0.1s",
              }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = T.surfaceHover; }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{
                  fontSize: 12, fontWeight: 600, fontFamily: T.sans,
                  color: isSelected ? color.bg : T.textPrimary,
                }}>{displayName}</span>
                {p.dob && (
                  <span style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono }}>
                    DOB: {p.dob}
                  </span>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: "24px 12px", fontSize: 12, color: T.textMuted, textAlign: "center" }}>
              No patients found
            </div>
          )}
        </div>
      </div>

      {/* Right: patient profile */}
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        {selectedPatient && syntheticWs ? (
          <PatientProfileContent patient={selectedPatient} workspace={syntheticWs} />
        ) : (
          <div style={{
            height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            color: T.textMuted, fontFamily: T.sans,
          }}>
            <div style={{ fontSize: 40, opacity: 0.12, marginBottom: 12, fontFamily: T.mono }}>⊘</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No patient selected</div>
            <div style={{ fontSize: 12, opacity: 0.5 }}>
              Select a patient from the list to view and edit their profile
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PrescriberCardContent({ patient, workspace }) {
  const { dispatch } = useContext(PharmIDEContext);
  const { getPrescriberById } = useData();
  const rxState = workspace.rxPrescription;
  const prescriberId = rxState?.prescriber?.id;
  const prescriber = prescriberId ? getPrescriberById(prescriberId) : rxState?.prescriber || null;

  if (!prescriber) {
    return (
      <div style={{ padding: 20, color: T.textMuted, fontSize: 13, textAlign: 'center' }}>
        No prescriber on file for this prescription.
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {prescriber.formerLastName && (
        <div style={{
          background: '#fef3c720', border: '1px solid #f59e0b60', borderRadius: 8,
          padding: '7px 10px', marginBottom: 12, fontSize: 11, color: '#f59e0b',
        }}>
          Name changed — formerly Dr. {prescriber.formerLastName}
          {prescriber.nameChangedAt ? ` (${prescriber.nameChangedAt.slice(0, 10)})` : ''}
        </div>
      )}
      <div style={{ fontSize: 16, fontWeight: 800, color: T.textPrimary, marginBottom: 4 }}>
        Dr. {prescriber.firstName} {prescriber.lastName}
        {prescriber.credentials ? `, ${prescriber.credentials}` : ''}
      </div>
      <div style={{ fontSize: 13, color: T.textSecondary, marginBottom: 10 }}>{prescriber.practice || ''}</div>
      {[
        ['DEA', prescriber.dea], ['NPI', prescriber.npi],
        ['Phone', prescriber.phone], ['Specialty', prescriber.specialty],
      ].filter(([, v]) => v).map(([label, val]) => (
        <div key={label} style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
          <span style={{ width: 60, fontSize: 11, color: T.textSecondary, fontWeight: 600, flexShrink: 0 }}>{label}</span>
          <span style={{ fontSize: 12, color: T.textPrimary, fontFamily: label === 'DEA' || label === 'NPI' ? T.mono : T.sans }}>{val}</span>
        </div>
      ))}
      {prescriber.id && (
        <button
          onClick={() => dispatch({ type: "CREATE_TASK_WORKSPACE", taskType: "prescriber_dir" })}
          style={{
            marginTop: 10, padding: '5px 12px', borderRadius: T.radiusSm,
            border: `1px solid ${T.surfaceBorder}`, background: 'transparent',
            color: T.textSecondary, cursor: 'pointer', fontSize: 11,
          }}
        >
          Open in Directory
        </button>
      )}
    </div>
  );
}

function TabContent({ tab, patient, workspace }) {
  switch (tab.type) {
    case "RX_ENTRY": return <RxEntryContent patient={patient} workspace={workspace} />;
    case "RPH_VERIFY": return <RphVerifyContent patient={patient} workspace={workspace} />;
    case "FILL": return <FillContent patient={patient} workspace={workspace} />;
    case "FILL_VERIFY": return <FillVerifyContent patient={patient} workspace={workspace} />;
    case "SOLD": return <SoldContent patient={patient} workspace={workspace} />;
    case "DATA_ENTRY_WS": return <DataEntryWorkspaceContent workspace={workspace} />;
    case "PATIENT_PROFILE": return <PatientProfileContent patient={patient} workspace={workspace} />;
    case "MED_HISTORY": return <MedHistoryContent patient={patient} workspace={workspace} />;
    case "INSURANCE": return <InsuranceContent patient={patient} workspace={workspace} />;
    case "ALLERGIES": return <AllergiesContent patient={patient} workspace={workspace} />;
    case "NOTES": return <NotesContent patient={patient} />;
    case "INVENTORY": return <InventoryWorkspace color={workspace?.color} />;
    case "RX_HISTORY": return <RxHistoryContent workspace={workspace} />;
    case "PICKUP": return <PickupContent workspace={workspace} />;
    case "DRUG_SEARCH": return <DrugSearchContent workspace={workspace} />;
    case "PRESCRIBER_DIR": return <PrescriberDirectoryContent workspace={workspace} />;
    case "PATIENT_MAINTENANCE": return <PatientMaintenanceContent workspace={workspace} />;
    case "PRESCRIBER_CARD": return <PrescriberCardContent patient={patient} workspace={workspace} />;
    default: return <div style={{ padding: 16 }}>Unknown tab type</div>;
  }
}


// ============================================================
// STATE MANAGEMENT
// ============================================================
const initialState = {
  workspaces: {},
  tiles: {},
  pages: {},
  pageOrder: [],
  activePageId: null,
  grid: { cols: GRID_COLS, rows: GRID_ROWS },
  colorIndex: 0,
  activeTileId: null,
  lastPatientPageId: null,
  lastTaskPageId: null,
  neutralMode: false,
};

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function findOpenPosition(tiles, size) {
  const occupied = new Set();
  tiles.forEach(t => {
    for (let r = t.row; r < t.row + t.rows; r++) {
      for (let c = t.col; c < t.col + t.cols; c++) {
        occupied.add(`${r}-${c}`);
      }
    }
  });
  for (let r = 0; r <= GRID_ROWS - size.rows; r++) {
    for (let c = 0; c <= GRID_COLS - size.cols; c++) {
      let fits = true;
      for (let dr = 0; dr < size.rows && fits; dr++) {
        for (let dc = 0; dc < size.cols && fits; dc++) {
          if (occupied.has(`${r + dr}-${c + dc}`)) fits = false;
        }
      }
      if (fits) return { row: r, col: c };
    }
  }
  return { row: 0, col: 0 };
}

function reducer(state, action) {
  switch (action.type) {
    case "CREATE_WORKSPACE": {
      const { patientId, eOrder: wsEOrder } = action;
      const existing = Object.values(state.workspaces).find(w => w.patientId === patientId);
      if (existing) {
        const existingTile = Object.values(state.tiles).find(t => t.workspaceId === existing.id);
        if (existingTile) return { ...state, activePageId: existingTile.pageId };
        return state;
      }
      const wsId = generateId();
      const pageId = generateId();
      const color = WORKSPACE_COLORS[state.colorIndex % WORKSPACE_COLORS.length];
      const tileId = generateId();
      const wsTabs = [
        { id: generateId(), type: "RX_ENTRY", label: "New Rx" },
        { id: generateId(), type: "RPH_VERIFY", label: "RPh Verify" },
        { id: generateId(), type: "FILL", label: "Fill" },
        { id: generateId(), type: "FILL_VERIFY", label: "Fill Verify" },
        { id: generateId(), type: "SOLD", label: "Dispensed" },
        { id: generateId(), type: "PATIENT_PROFILE", label: "Profile" },
        { id: generateId(), type: "MED_HISTORY", label: "Med History" },
        { id: generateId(), type: "INSURANCE", label: "Insurance" },
        { id: generateId(), type: "ALLERGIES", label: "Allergies" },
        { id: generateId(), type: "NOTES", label: "Notes" },
      ];
      const initialTab = action.initialTabType
        ? (wsTabs.find(t => t.type === action.initialTabType) || wsTabs[0])
        : wsTabs[0];
      const size = SNAP_SIZES.HALF_H;
      return {
        ...state,
        colorIndex: state.colorIndex + 1,
        activePageId: pageId,
        pages: { ...state.pages, [pageId]: { id: pageId, workspaceId: wsId, label: null } },
        pageOrder: [...state.pageOrder, pageId],
        workspaces: {
          ...state.workspaces,
          [wsId]: {
            id: wsId, patientId, color,
            pendingEOrder: wsEOrder || null,
            rxPrescription: null,
            tabs: wsTabs,
          },
        },
        tiles: {
          ...state.tiles,
          [tileId]: {
            id: tileId, workspaceId: wsId, pageId,
            tabIds: [initialTab.id], activeTabId: initialTab.id,
            col: 0, row: 0, cols: size.cols, rows: size.rows,
          },
        },
        activeTileId: tileId,
      };
    }
    case "CREATE_TASK_WORKSPACE": {
      const { taskType } = action; // "data_entry" | "fill" | "verify" | "inventory"
      // Check if one already exists
      const existingTask = Object.values(state.workspaces).find(w => w.taskType === taskType);
      if (existingTask) {
        const existingPage = Object.values(state.pages).find(p => p.workspaceId === existingTask.id);
        if (existingPage) return { ...state, activePageId: existingPage.id };
        return state;
      }
      const wsId = generateId();
      const pageId = generateId();
      const color = taskType === "data_entry"
        ? { bg: "#5b8af5", text: "#a0bff0", border: "#223050", light: "#141a24" }
        : taskType === "verify"
          ? { bg: "#4abe6a", text: "#90e0a0", border: "#223d28", light: "#141f18" }
          : taskType === "inventory"
            ? { bg: "#40c0b0", text: "#90e0d0", border: "#223d38", light: "#141f1e" }
            : taskType === "rx_history"
              ? { bg: "#9b7fe8", text: "#c8b4f0", border: "#2d2348", light: "#1a1528" }
              : taskType === "pickup"
                ? { bg: "#38bdf8", text: "#93c5fd", border: "#1e3a52", light: "#0f1f2e" }
                : taskType === "prescriber_dir"
                  ? { bg: "#c084fc", text: "#e9d5ff", border: "#3b1f5a", light: "#1e1028" }
                  : taskType === "patient_maintenance"
                    ? { bg: "#f97316", text: "#fed7aa", border: "#431407", light: "#1c0a03" }
                    : { bg: "#e8a030", text: "#f0d090", border: "#3d3020", light: "#1f1a14" };
      const tileId = generateId();
      const tabId = generateId();
      const tabType = taskType === "inventory" ? "INVENTORY"
        : taskType === "rx_history" ? "RX_HISTORY"
        : taskType === "pickup" ? "PICKUP"
        : taskType === "prescriber_dir" ? "PRESCRIBER_DIR"
        : taskType === "patient_maintenance" ? "PATIENT_MAINTENANCE"
        : "DATA_ENTRY_WS";
      const tabLabel = taskType === "data_entry" ? "Data Entry"
        : taskType === "inventory" ? "Inventory"
          : taskType === "rx_history" ? "Rx History"
          : taskType === "pickup" ? "Pickup"
          : taskType === "prescriber_dir" ? "Prescribers"
          : taskType === "patient_maintenance" ? "Patients"
          : taskType === "verify" ? "RPh Verify" : "Fill Station";
      return {
        ...state,
        colorIndex: state.colorIndex + 1,
        activePageId: pageId,
        pages: { ...state.pages, [pageId]: { id: pageId, workspaceId: wsId, label: tabLabel } },
        pageOrder: [...state.pageOrder, pageId],
        workspaces: {
          ...state.workspaces,
          [wsId]: {
            id: wsId, patientId: null, taskType, color,
            rxPrescription: null,
            activeQueueItem: null,
            tabs: [
              { id: tabId, type: tabType, label: tabLabel },
            ],
          },
        },
        tiles: {
          ...state.tiles,
          [tileId]: {
            id: tileId, workspaceId: wsId, pageId,
            tabIds: [tabId], activeTabId: tabId,
            col: 0, row: 0, cols: GRID_COLS, rows: GRID_ROWS,
          },
        },
        activeTileId: tileId,
      };
    }

    case "SET_QUEUE_ITEM": {
      const { workspaceId, patientId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...ws, activeQueueItem: { patientId } },
        },
      };
    }

    case "OPEN_TAB_IN_TILE": {
      const { tileId, tabId } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      const newTabIds = tile.tabIds.includes(tabId) ? tile.tabIds : [...tile.tabIds, tabId];
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, tabIds: newTabIds, activeTabId: tabId } } };
    }
    case "SET_ACTIVE_TAB": {
      const { tileId, tabId } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, activeTabId: tabId } }, activeTileId: tileId };
    }
    case "DETACH_TAB": {
      const { tileId, tabId, col: dropCol, row: dropRow } = action;
      const tile = state.tiles[tileId];
      if (!tile || tile.tabIds.length <= 1) return state;
      const newTileId = generateId();
      const remainingTabs = tile.tabIds.filter(id => id !== tabId);
      const size = SNAP_SIZES.QUARTER;
      const pageTiles = Object.values(state.tiles).filter(t => t.pageId === tile.pageId);
      const pos = (dropCol !== undefined && dropRow !== undefined)
        ? { row: Math.max(0, Math.min(dropRow, GRID_ROWS - size.rows)), col: Math.max(0, Math.min(dropCol, GRID_COLS - size.cols)) }
        : findOpenPosition(pageTiles, size);
      return {
        ...state,
        tiles: {
          ...state.tiles,
          [tileId]: { ...tile, tabIds: remainingTabs, activeTabId: remainingTabs[0] },
          [newTileId]: { id: newTileId, workspaceId: tile.workspaceId, pageId: tile.pageId, tabIds: [tabId], activeTabId: tabId, col: pos.col, row: pos.row, cols: size.cols, rows: size.rows },
        },
        activeTileId: newTileId,
      };
    }
    case "REATTACH_TAB": {
      const { fromTileId, toTileId, tabId } = action;
      const fromTile = state.tiles[fromTileId];
      const toTile = state.tiles[toTileId];
      if (!fromTile || !toTile) return state;
      if (fromTile.workspaceId !== toTile.workspaceId) return state;
      const newTiles = { ...state.tiles };
      newTiles[toTileId] = { ...toTile, tabIds: [...toTile.tabIds, tabId], activeTabId: tabId };
      if (fromTile.tabIds.length <= 1) {
        delete newTiles[fromTileId];
      } else {
        const remaining = fromTile.tabIds.filter(id => id !== tabId);
        newTiles[fromTileId] = { ...fromTile, tabIds: remaining, activeTabId: remaining[0] };
      }
      return { ...state, tiles: newTiles, activeTileId: toTileId };
    }
    case "CLOSE_TAB": {
      const { tileId, tabId } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      const remaining = tile.tabIds.filter(id => id !== tabId);
      if (remaining.length > 0) {
        return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, tabIds: remaining, activeTabId: remaining[0] } } };
      }
      // Tile would be empty — delete it
      const newTiles = { ...state.tiles };
      delete newTiles[tileId];
      const pageStillHasTiles = Object.values(newTiles).some(t => t.pageId === tile.pageId);
      if (pageStillHasTiles) {
        return { ...state, tiles: newTiles, activeTileId: state.activeTileId === tileId ? null : state.activeTileId };
      }
      // Last tile on the page — close the whole workspace so the tab doesn't orphan
      const wsId = tile.workspaceId;
      const newWorkspaces = { ...state.workspaces };
      delete newWorkspaces[wsId];
      const newPages = { ...state.pages };
      const removedPageIds = new Set();
      Object.entries(newPages).forEach(([id, page]) => {
        if (page.workspaceId === wsId) { removedPageIds.add(id); delete newPages[id]; }
      });
      const newPageOrder = state.pageOrder.filter(id => !removedPageIds.has(id));
      let newActivePageId = state.activePageId;
      if (removedPageIds.has(state.activePageId))
        newActivePageId = newPageOrder.length > 0 ? newPageOrder[newPageOrder.length - 1] : null;
      return { ...state, workspaces: newWorkspaces, tiles: newTiles, pages: newPages, pageOrder: newPageOrder, activePageId: newActivePageId };
    }
    case "OPEN_DRUG_SEARCH": {
      const { workspaceId, initialQuery = "" } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      let dsTab = ws.tabs.find(t => t.type === "DRUG_SEARCH");
      let newTabs = ws.tabs;
      if (!dsTab) {
        dsTab = { id: generateId(), type: "DRUG_SEARCH", label: "Drug Browser" };
        newTabs = [...ws.tabs, dsTab];
      }
      const rxEntryTab = ws.tabs.find(t => t.type === "RX_ENTRY");
      const targetTile = (rxEntryTab && Object.values(state.tiles).find(t => t.tabIds.includes(rxEntryTab.id)))
        || Object.values(state.tiles).find(t => t.workspaceId === workspaceId);
      if (!targetTile) return state;
      const newTabIds = targetTile.tabIds.includes(dsTab.id) ? targetTile.tabIds : [...targetTile.tabIds, dsTab.id];
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...ws, tabs: newTabs, drugSearchInitialQuery: initialQuery },
        },
        tiles: {
          ...state.tiles,
          [targetTile.id]: { ...targetTile, tabIds: newTabIds, activeTabId: dsTab.id },
        },
      };
    }
    case "DRUG_SEARCH_SELECT": {
      const { workspaceId, drug, product } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      const dsTab = ws.tabs.find(t => t.type === "DRUG_SEARCH");
      const rxEntryTab = ws.tabs.find(t => t.type === "RX_ENTRY");
      const tile = dsTab ? Object.values(state.tiles).find(t => t.tabIds.includes(dsTab.id)) : null;
      const newTiles = (tile && rxEntryTab)
        ? { ...state.tiles, [tile.id]: { ...tile, activeTabId: rxEntryTab.id } }
        : state.tiles;
      return {
        ...state,
        workspaces: { ...state.workspaces, [workspaceId]: { ...ws, pendingDrugSelection: { drug, product } } },
        tiles: newTiles,
      };
    }
    case "CLEAR_DRUG_SELECTION": {
      const { workspaceId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      return {
        ...state,
        workspaces: { ...state.workspaces, [workspaceId]: { ...ws, pendingDrugSelection: null } },
      };
    }
    case "RESIZE_TILE": {
      const { tileId, size } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, cols: size.cols, rows: size.rows } } };
    }
    case "MOVE_TILE": {
      const { tileId, col, row } = action;
      const tile = state.tiles[tileId];
      if (!tile) return state;
      return { ...state, tiles: { ...state.tiles, [tileId]: { ...tile, col: Math.max(0, Math.min(col, GRID_COLS - tile.cols)), row: Math.max(0, Math.min(row, GRID_ROWS - tile.rows)) } } };
    }
    case "SET_ACTIVE_TILE": return { ...state, activeTileId: action.tileId };
    case "CLOSE_WORKSPACE": {
      const { workspaceId } = action;
      const newWorkspaces = { ...state.workspaces };
      delete newWorkspaces[workspaceId];
      const newTiles = {};
      Object.entries(state.tiles).forEach(([id, tile]) => { if (tile.workspaceId !== workspaceId) newTiles[id] = tile; });
      const newPages = { ...state.pages };
      const removedPageIds = new Set();
      Object.entries(newPages).forEach(([id, page]) => { if (page.workspaceId === workspaceId) { removedPageIds.add(id); delete newPages[id]; } });
      const newPageOrder = state.pageOrder.filter(id => !removedPageIds.has(id));
      let newActivePageId = state.activePageId;
      if (removedPageIds.has(state.activePageId)) newActivePageId = newPageOrder.length > 0 ? newPageOrder[newPageOrder.length - 1] : null;
      return { ...state, workspaces: newWorkspaces, tiles: newTiles, pages: newPages, pageOrder: newPageOrder, activePageId: newActivePageId };
    }
    case "SET_ACTIVE_PAGE": return { ...state, activePageId: action.pageId };
    case "NAVIGATE_PAGE": {
      const idx = state.pageOrder.indexOf(state.activePageId);
      if (idx === -1) return state;
      const newIdx = action.direction === "next" ? (idx + 1) % state.pageOrder.length : (idx - 1 + state.pageOrder.length) % state.pageOrder.length;
      return { ...state, activePageId: state.pageOrder[newIdx] };
    }

    case "NAVIGATE_TASK_PAGE": {
      const taskOnly = state.pageOrder.filter(pid => {
        const ws = state.workspaces[state.pages[pid]?.workspaceId];
        return ws?.taskType && !ws?.patientId;
      });
      if (taskOnly.length < 2) return state;
      const idx = taskOnly.indexOf(state.activePageId);
      const from = idx === -1 ? 0 : idx;
      const newIdx = action.direction === "next"
        ? (from + 1) % taskOnly.length
        : (from - 1 + taskOnly.length) % taskOnly.length;
      return { ...state, activePageId: taskOnly[newIdx] };
    }

    case "SWITCH_TAB_GROUP": {
      const currentId = state.activePageId;
      const currentWs = state.workspaces[state.pages[currentId]?.workspaceId];
      const isPatient = !!currentWs?.patientId;
      const patientPageIds = state.pageOrder.filter(pid => !!state.workspaces[state.pages[pid]?.workspaceId]?.patientId);
      const taskPageIds = state.pageOrder.filter(pid => { const ws = state.workspaces[state.pages[pid]?.workspaceId]; return ws?.taskType && !ws?.patientId; });
      if (isPatient) {
        const targetId = (state.lastTaskPageId && taskPageIds.includes(state.lastTaskPageId)) ? state.lastTaskPageId : taskPageIds[0];
        if (!targetId) return state;
        return { ...state, activePageId: targetId, lastPatientPageId: currentId };
      } else {
        const targetId = (state.lastPatientPageId && patientPageIds.includes(state.lastPatientPageId)) ? state.lastPatientPageId : patientPageIds[0];
        if (!targetId) return state;
        return { ...state, activePageId: targetId, lastTaskPageId: currentId };
      }
    }

    case "TOGGLE_NEUTRAL_MODE": return { ...state, neutralMode: !state.neutralMode };

    // Set by async backend call when a patient workspace first opens
    case "INIT_PRESCRIPTION": {
      const { workspaceId, prescription } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription) return state; // don't overwrite existing
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              id: prescription.id,
              status: prescription.status,
              rxNumber: null,
              techEntryData: null,
              eOrder: null,
              rphReviewData: null,
              fillData: null,
              rphFillReviewData: null,
            },
          },
        },
      };
    }

    // Simple status-only update — used for START_ENTRY transition
    case "SET_RX_STATUS": {
      const { workspaceId, status } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || !ws.rxPrescription) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: { ...ws.rxPrescription, status },
          },
        },
      };
    }

    case "SUBMIT_RX": {
      const { workspaceId, techEntryData, eOrder, transitionResult } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription, // preserves id from INIT_PRESCRIPTION
              status: transitionResult?.newStatus || "pending_review",
              techEntryData,
              eOrder: eOrder || null,
              rphReviewData: null,
              submittedAt: transitionResult?.timestamp || new Date().toISOString(),
            },
          },
        },
      };
    }

    case "RESUBMIT_RX": {
      const { workspaceId, techEntryData, eOrder, transitionResult } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "returned") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: transitionResult?.newStatus || "pending_review",
              techEntryData,
              eOrder: eOrder || ws.rxPrescription.eOrder,
              rphReviewData: null,
              resubmittedAt: transitionResult?.timestamp || new Date().toISOString(),
            },
          },
        },
      };
    }

    case "RPH_APPROVE": {
      const { workspaceId, notes, checkedFields, transitionResult } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || !ws.rxPrescription) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: transitionResult?.newStatus || "approved",
              rxNumber: transitionResult?.rxNumber ?? ws.rxPrescription.rxNumber,
              rphReviewData: { decision: "approve", notes: notes || "", checkedFields: checkedFields || [], decidedAt: transitionResult?.timestamp || new Date().toISOString() },
            },
          },
        },
      };
    }

    case "RPH_RETURN": {
      const { workspaceId, notes, checkedFields } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || !ws.rxPrescription) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "returned",
              rphReviewData: { decision: "return", notes: notes || "", checkedFields: checkedFields || [], decidedAt: new Date().toISOString() },
            },
          },
        },
      };
    }

    case "RPH_CALL": {
      const { workspaceId, notes, checkedFields } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || !ws.rxPrescription) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "call_prescriber",
              rphReviewData: { decision: "call_prescriber", notes: notes || "", checkedFields: checkedFields || [], decidedAt: new Date().toISOString() },
            },
          },
        },
      };
    }

    case "RESOLVE_CALL": {
      const { workspaceId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "call_prescriber") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: { ...ws.rxPrescription, status: "pending_review" },
          },
        },
      };
    }

    case "RESET_RX": {
      const { workspaceId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws) return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...ws, rxPrescription: null },
        },
      };
    }

    case "START_FILL": {
      const { workspaceId } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "approved") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "in_fill",
              fillData: null,
            },
          },
        },
      };
    }

    case "SUBMIT_FILL": {
      const { workspaceId, fillData } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "in_fill") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "pending_fill_verify",
              fillData: {
                ...fillData,
                submittedAt: new Date().toISOString(),
              },
              rphFillReviewData: null,
            },
          },
        },
      };
    }

    case "RPH_VERIFY_FILL": {
      const { workspaceId, notes } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "pending_fill_verify") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "ready",
              rphFillReviewData: { decision: "approve", notes: notes || "", decidedAt: new Date().toISOString() },
            },
          },
        },
      };
    }

    case "RPH_REJECT_FILL": {
      const { workspaceId, notes } = action;
      const ws = state.workspaces[workspaceId];
      if (!ws || ws.rxPrescription?.status !== "pending_fill_verify") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            rxPrescription: {
              ...ws.rxPrescription,
              status: "in_fill",
              fillData: null,
              rphFillReviewData: { decision: "refill", notes: notes || "", decidedAt: new Date().toISOString() },
            },
          },
        },
      };
    }

    case "RESTORE_PRESCRIPTION": {
      const { prescription } = action;
      // Find if there's already a workspace for this patient
      const existingWs = Object.values(state.workspaces).find(ws => ws.patientId === prescription.patientId);
      if (existingWs && existingWs.rxPrescription) return state; // don't overwrite in-progress work
      if (existingWs) {
        // Attach to existing workspace
        return {
          ...state,
          workspaces: {
            ...state.workspaces,
            [existingWs.id]: {
              ...existingWs,
              rxPrescription: {
                id: prescription.id,
                rxNumber: prescription.rxNumber,
                status: prescription.status,
                techEntryData: prescription.techEntryData ? JSON.parse(prescription.techEntryData) : null,
                eOrder: prescription.eorderData ? JSON.parse(prescription.eorderData) : null,
                rphReviewData: prescription.rphReviewData ? JSON.parse(prescription.rphReviewData) : null,
                fillData: prescription.fillData ? JSON.parse(prescription.fillData) : null,
                rphFillReviewData: prescription.rphFillReviewData ? JSON.parse(prescription.rphFillReviewData) : null,
                restoredAt: new Date().toISOString(),
              },
            },
          },
        };
      }
      // No existing workspace — skip for now (workspace is created when patient is opened)
      return state;
    }

    case "SELL_RX": {
      const { rxId } = action;
      const newWorkspaces = { ...state.workspaces };
      const newTiles = { ...state.tiles };
      let newActivePageId = state.activePageId;

      Object.keys(newWorkspaces).forEach(wsId => {
        const ws = newWorkspaces[wsId];
        if (ws.rxPrescription?.id !== rxId) return;

        newWorkspaces[wsId] = { ...ws, rxPrescription: { ...ws.rxPrescription, status: "sold" } };

        // Navigate to the SOLD tab in this workspace's tile
        const soldTab = ws.tabs.find(t => t.type === "SOLD");
        if (soldTab) {
          const tile = Object.values(state.tiles).find(t => t.workspaceId === wsId);
          if (tile) {
            const tabIds = tile.tabIds.includes(soldTab.id) ? tile.tabIds : [...tile.tabIds, soldTab.id];
            newTiles[tile.id] = { ...tile, tabIds, activeTabId: soldTab.id };
          }
          const page = Object.values(state.pages).find(p => p.workspaceId === wsId);
          if (page) newActivePageId = page.id;
        }
      });

      return { ...state, workspaces: newWorkspaces, tiles: newTiles, activePageId: newActivePageId };
    }

    default: return state;
  }
}


// ============================================================
// CONTEXT
// ============================================================
const PharmIDEContext = createContext(null);

// Reactive patient name — reads from the store, re-renders when patient updates
function PatientName({ patientId, fallback = "" }) {
  const { getEntity } = useData();
  const p = patientId ? getEntity('patient', patientId) : null;
  return p?.name || fallback;
}

// Shared tab drag state (mouse-event based, bypasses HTML5 DnD issues in WebView2)
const tabDragState = { active: false, tabId: null, fromTileId: null, workspaceId: null, tabCount: 0, ghostEl: null };


// ============================================================
// QUEUE BAR — Rx pipeline at the bottom of the screen
// ============================================================
const QUEUE_LANES = [
  { status: null, label: "Incoming", icon: "→", color: T.textMuted, tabType: "RX_ENTRY" },
  { status: "pending_review", label: "RPh Review", icon: "Rv", color: T.textSecondary, tabType: "RPH_VERIFY" },
  { status: "approved", label: "Ready to Fill", icon: "✓", color: T.textSecondary, tabType: "FILL" },
  { status: "in_fill", label: "Filling", icon: "Fl", color: T.textSecondary, tabType: "FILL" },
  { status: "pending_fill_verify", label: "Fill Check", icon: "Fv", color: T.textSecondary, tabType: "FILL_VERIFY" },
  { status: "ready", label: "Pickup", icon: "✓", color: T.textSecondary, tabType: null },
];

function QueueBar({ state, currentRole, onRxClick }) {
  const [collapsed, setCollapsed] = useState(true);
  const { getEntity, getEntities } = useData();
  const { neutralMode } = useContext(PharmIDEContext);

  // Collect all in-flight Rxs — workspace state takes priority, store fills gaps.
  const allRxs = useMemo(() => {
    const byPatientId = new Map();

    // Primary: workspace state (live in-session data, always up-to-date)
    Object.values(state.workspaces).forEach(ws => {
      const patient = getEntity('patient', ws.patientId);
      if (!patient) return;
      const rx = ws.rxPrescription;
      if (rx?.status === "sold") return;

      if (!rx) {
        byPatientId.set(ws.patientId, {
          workspaceId: ws.id, status: null, patient, color: neutralMode ? NEUTRAL_WS_COLOR : ws.color,
          drugName: "New Rx", strength: "", rxNumber: null, age: null, isControl: false,
        });
      } else {
        const te = rx.techEntryData || {};
        const age = rx.submittedAt ? Math.floor((Date.now() - new Date(rx.submittedAt).getTime()) / 60000) : null;
        byPatientId.set(ws.patientId, {
          workspaceId: ws.id, status: rx.status, patient, color: neutralMode ? NEUTRAL_WS_COLOR : ws.color,
          drugName: te.drugName || "—", strength: te.strength || "",
          rxNumber: rx.rxNumber, age,
          isControl: te.schedule?.startsWith("C-"), schedule: te.schedule,
        });
      }
    });

    // Supplement: store prescriptions not already covered by an open workspace
    getEntities('prescription').forEach(rx => {
      if (rx.status === 'sold') return;
      if (byPatientId.has(rx.patientId)) return; // workspace takes priority
      const patient = getEntity('patient', rx.patientId);
      if (!patient) return;
      const ws = Object.values(state.workspaces).find(w => w.patientId === rx.patientId);
      if (!ws) return; // only display if workspace is open
      const te = rx.techEntryData || {};
      const age = rx.createdAt ? Math.floor((Date.now() - new Date(rx.createdAt).getTime()) / 60000) : null;
      byPatientId.set(rx.patientId, {
        workspaceId: ws.id, status: rx.status, patient, color: neutralMode ? NEUTRAL_WS_COLOR : ws.color,
        drugName: te.drugName || "—", strength: te.strength || "",
        rxNumber: rx.rxNumber || null, age,
        isControl: te.schedule?.startsWith("C-"), schedule: te.schedule,
      });
    });

    return Array.from(byPatientId.values());
  }, [state.workspaces, getEntities, getEntity]);

  // Group by lane
  const lanes = useMemo(() => {
    return QUEUE_LANES.map(lane => ({
      ...lane,
      rxs: allRxs.filter(rx => {
        if (lane.status === null) return rx.status === null || rx.status === "in_entry" || rx.status === "returned" || rx.status === "call_prescriber";
        return rx.status === lane.status;
      }),
    }));
  }, [allRxs]);

  // Summary counts for collapsed view
  const totalActive = allRxs.filter(rx => rx.status && rx.status !== "ready").length;
  const needsAttention = useMemo(() => {
    if (currentRole === "tech") {
      return allRxs.filter(rx => rx.status === null || rx.status === "approved" || rx.status === "in_fill" || rx.status === "returned").length;
    }
    if (currentRole === "rph") {
      return allRxs.filter(rx => rx.status === "pending_review" || rx.status === "pending_fill_verify").length;
    }
    return 0;
  }, [allRxs, currentRole]);

  if (allRxs.length === 0) return null;

  return (
    <div style={{
      background: T.queueBg, borderTop: `1px solid ${T.surfaceBorder}`,
      flexShrink: 0, fontFamily: T.mono,
      transition: "height 0.2s ease",
    }}>
      {/* Queue header — always visible */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          height: 30, display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 14px", cursor: "pointer", userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: T.textSecondary, textTransform: "uppercase", letterSpacing: 1 }}>
            Queue
          </span>
          {lanes.map(lane => (
            lane.rxs.length > 0 && (
              <span key={lane.label} style={{
                fontSize: 9, padding: "2px 7px", borderRadius: T.radiusSm,
                background: lane.color + "18", color: lane.color + "cc",
                fontWeight: 600,
              }}>
                {lane.rxs.length} {lane.label}
              </span>
            )
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {needsAttention > 0 && (
            <span style={{ fontSize: 10, color: T.textSecondary, fontWeight: 600 }}>
              {needsAttention} need{needsAttention === 1 ? "s" : ""} attention
            </span>
          )}
          <span style={{ fontSize: 12, color: T.textMuted, transition: "transform 0.2s", transform: collapsed ? "rotate(0)" : "rotate(180deg)" }}>▲</span>
        </div>
      </div>

      {/* Queue lanes — collapsible */}
      {!collapsed && (
        <div style={{
          display: "flex", gap: 3, padding: "0 10px 10px", height: 110,
          overflowX: "auto", overflowY: "hidden",
        }}>
          {lanes.map(lane => (
            <div key={lane.label} style={{
              flex: lane.rxs.length > 0 ? `${Math.max(lane.rxs.length, 1)}` : "0 0 auto",
              minWidth: lane.rxs.length > 0 ? 120 : 60,
              display: "flex", flexDirection: "column",
            }}>
              {/* Lane header */}
              <div style={{
                fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8,
                color: lane.color + "aa", padding: "2px 8px", marginBottom: 4,
                display: "flex", alignItems: "center", gap: 4,
              }}>
                <span>{lane.icon}</span>
                <span>{lane.label}</span>
                {lane.rxs.length > 0 && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: lane.color + "88",
                    background: lane.color + "10", borderRadius: T.radiusSm,
                    padding: "0 5px", marginLeft: 2,
                  }}>
                    {lane.rxs.length}
                  </span>
                )}
              </div>

              {/* Rx cards */}
              <div style={{
                flex: 1, display: "flex", gap: 4, overflowX: "auto",
                padding: "0 4px",
              }}>
                {lane.rxs.map((rx, i) => (
                  <div
                    key={rx.workspaceId + "-" + i}
                    onClick={() => lane.tabType && onRxClick(rx.workspaceId, lane.tabType)}
                    style={{
                      minWidth: 110, maxWidth: 150, padding: "7px 9px",
                      borderRadius: T.radiusSm, cursor: lane.tabType ? "pointer" : "default",
                      background: `${rx.color.bg}10`,
                      border: `1px solid ${rx.color.bg}20`,
                      display: "flex", flexDirection: "column", justifyContent: "space-between",
                      transition: "all 0.15s",
                      flexShrink: 0,
                    }}
                    onMouseOver={(e) => { if (lane.tabType) e.currentTarget.style.background = rx.color.bg + "20"; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = rx.color.bg + "10"; }}
                  >
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary, lineHeight: 1.3 }}>
                        {rx.drugName} {rx.strength}
                      </div>
                      <div style={{ fontSize: 9, color: T.textMuted, marginTop: 2 }}>
                        {rx.patient.name.split(" ").pop()}
                        {rx.rxNumber && <span style={{ marginLeft: 4, color: T.textMuted }}>· Rx# {rx.rxNumber}</span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
                      {rx.isControl && (
                        <span style={{
                          fontSize: 8, fontWeight: 800, color: "#e8a030",
                          background: "#f59e0b15", padding: "0 4px", borderRadius: 2,
                        }}>
                          {rx.schedule}
                        </span>
                      )}
                      {rx.age != null && (
                        <span style={{
                          fontSize: 8, color: rx.age > 15 ? "#f59e0b" : rx.age > 30 ? "#ef4444" : "#475569",
                          fontWeight: rx.age > 15 ? 700 : 400,
                        }}>
                          {rx.age}m
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {lane.rxs.length === 0 && (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#2a2d3a", fontSize: 10 }}>
                    —
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ============================================================
// TILE COMPONENT
// ============================================================
function Tile({ tile, workspace }) {
  const { dispatch, state, neutralMode } = useContext(PharmIDEContext);
  const { getEntity } = useData();
  const patient = workspace.patientId ? getEntity('patient', workspace.patientId) : null;
  const [isDragging, setIsDragging] = useState(false);
  const [showTabSearch, setShowTabSearch] = useState(false);
  const [dropHighlight, setDropHighlight] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeCols, setResizeCols] = useState(null);
  const [resizeRows, setResizeRows] = useState(null);
  const tileRef = useRef(null);
  const gridRef = useRef(null);

  const color = neutralMode ? NEUTRAL_WS_COLOR : workspace.color;
  const allTabs = workspace.tabs;
  const openTabs = allTabs.filter(t => tile.tabIds.includes(t.id));
  const activeTab = allTabs.find(t => t.id === tile.activeTabId);
  const availableTabs = allTabs.filter(t => !tile.tabIds.includes(t.id));

  const handleTabMouseDown = (e, tabId) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;

    const onMove = (me) => {
      if (!dragging && (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5)) {
        dragging = true;
        tabDragState.active = true;
        tabDragState.tabId = tabId;
        tabDragState.fromTileId = tile.id;
        tabDragState.workspaceId = workspace.id;
        tabDragState.tabCount = tile.tabIds.length;
        // Create ghost
        const ghost = document.createElement("div");
        ghost.textContent = allTabs.find(t => t.id === tabId)?.label || "Tab";
        Object.assign(ghost.style, {
          position: "fixed", zIndex: 9999, padding: "6px 14px", borderRadius: "8px",
          background: color.bg, color: "#fff", fontSize: "12px", fontWeight: "600",
          fontFamily: T.sans, pointerEvents: "none", opacity: "0.9",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          transform: "translate(-50%, -50%)",
        });
        document.body.appendChild(ghost);
        tabDragState.ghostEl = ghost;
      }
      if (dragging && tabDragState.ghostEl) {
        tabDragState.ghostEl.style.left = me.clientX + "px";
        tabDragState.ghostEl.style.top = me.clientY + "px";
      }
    };

    const onUp = (me) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (tabDragState.ghostEl) {
        tabDragState.ghostEl.remove();
        tabDragState.ghostEl = null;
      }
      if (!dragging) {
        // Was just a click, activate the tab
        dispatch({ type: "SET_ACTIVE_TAB", tileId: tile.id, tabId });
        tabDragState.active = false;
        return;
      }
      // Find what we dropped on
      const gridEl = tileRef.current?.closest("[data-grid]");
      if (!gridEl) { tabDragState.active = false; return; }
      const gridRect = gridEl.getBoundingClientRect();
      const cellW = gridRect.width / GRID_COLS, cellH = gridRect.height / GRID_ROWS;
      const col = Math.max(0, Math.min(GRID_COLS - 6, Math.round((me.clientX - gridRect.left) / cellW - 3)));
      const row = Math.max(0, Math.min(GRID_ROWS - 4, Math.round((me.clientY - gridRect.top) / cellH - 2)));

      // Check if dropped on another tile of the same workspace
      const dropTarget = document.elementFromPoint(me.clientX, me.clientY);
      const targetTileEl = dropTarget?.closest?.("[data-tile-id]");
      const targetTileId = targetTileEl?.dataset?.tileId;

      if (targetTileId && targetTileId !== tile.id) {
        // Check if same workspace
        const targetTile = state.tiles[targetTileId];
        if (targetTile && targetTile.workspaceId === workspace.id) {
          dispatch({ type: "REATTACH_TAB", fromTileId: tile.id, toTileId: targetTileId, tabId });
          tabDragState.active = false;
          return;
        }
      }

      // Drop on grid — detach or move
      if (tabDragState.tabCount <= 1) {
        dispatch({ type: "MOVE_TILE", tileId: tile.id, col, row });
      } else {
        dispatch({ type: "DETACH_TAB", tileId: tile.id, tabId, col, row });
      }
      tabDragState.active = false;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleTileMouseDown = (e) => {
    if (e.target.closest("[data-tab-bar]") || e.target.closest("[data-resize]") || e.target.closest("button")) return;
    e.preventDefault();
    dispatch({ type: "SET_ACTIVE_TILE", tileId: tile.id });
    setIsDragging(true);
    gridRef.current = tileRef.current.closest("[data-grid]");
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e) => {
      const grid = gridRef.current; if (!grid) return;
      const gridRect = grid.getBoundingClientRect();
      const col = Math.round((e.clientX - gridRect.left) / (gridRect.width / GRID_COLS) - tile.cols / 2);
      const row = Math.round((e.clientY - gridRect.top) / (gridRect.height / GRID_ROWS) - tile.rows / 2);
      dispatch({ type: "MOVE_TILE", tileId: tile.id, col, row });
    };
    const handleMouseUp = () => setIsDragging(false);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
  }, [isDragging, tile.id, tile.cols, tile.rows, dispatch]);

  const handleResizeMouseDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    setIsResizing(true); setResizeCols(tile.cols); setResizeRows(tile.rows);
    gridRef.current = tileRef.current.closest("[data-grid]");
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e) => {
      const grid = gridRef.current; if (!grid) return;
      const gridRect = grid.getBoundingClientRect();
      const cellW = gridRect.width / GRID_COLS;
      const cellH = gridRect.height / GRID_ROWS;
      setResizeCols(Math.min(Math.max(2, Math.round((e.clientX - gridRect.left) / cellW - tile.col)), GRID_COLS - tile.col));
      setResizeRows(Math.min(Math.max(2, Math.round((e.clientY - gridRect.top) / cellH - tile.row)), GRID_ROWS - tile.row));
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      const liveCols = resizeCols || tile.cols;
      const liveRows = resizeRows || tile.rows;
      let bestSize = null, bestDist = Infinity;
      Object.values(SNAP_SIZES).forEach(size => {
        if (tile.col + size.cols > GRID_COLS || tile.row + size.rows > GRID_ROWS) return;
        const dist = Math.abs(size.cols - liveCols) + Math.abs(size.rows - liveRows);
        if (dist < bestDist) { bestDist = dist; bestSize = size; }
      });
      if (bestSize) dispatch({ type: "RESIZE_TILE", tileId: tile.id, size: bestSize });
      setResizeCols(null); setResizeRows(null);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
  }, [isResizing, tile.id, tile.col, tile.row, tile.cols, tile.rows, resizeCols, resizeRows, dispatch]);

  return (
    <div
      ref={tileRef}
      data-tile-id={tile.id}
      onClick={() => dispatch({ type: "SET_ACTIVE_TILE", tileId: tile.id })}
      onDrop={null}
      onDragOver={null}
      onDragLeave={null}
      style={{
        gridColumn: `${tile.col + 1} / span ${isResizing && resizeCols ? resizeCols : tile.cols}`,
        gridRow: `${tile.row + 1} / span ${isResizing && resizeRows ? resizeRows : tile.rows}`,
        display: "flex", flexDirection: "column", borderRadius: T.radius,
        border: dropHighlight ? `3px dashed ${color.bg}` : "none",
        background: T.tileBg,
        overflow: "hidden",
        boxShadow: isDragging || isResizing
          ? `0 16px 48px ${color.bg}30, 0 0 0 2px ${color.bg}60`
          : `0 4px 28px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.07), inset 0 1px 0 ${color.bg}14`,
        zIndex: isDragging || isResizing ? 100 : (tile.id === state.activeTileId ? 10 : 1),
        transition: isDragging || isResizing ? "none" : "box-shadow 0.2s ease",
        cursor: isDragging ? "grabbing" : "default", position: "relative",
      }}
    >
      {/* Title bar */}
      <div onMouseDown={handleTileMouseDown} style={{
        background: T.surface,
        borderBottom: `1px solid rgba(255,255,255,0.05)`,
        color: T.textPrimary, padding: "8px 14px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        cursor: "grab", userSelect: "none", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: color.bg, opacity: 0.8, boxShadow: `0 0 6px ${color.bg}60` }} />
          <span style={{ fontWeight: 600, fontSize: 13, fontFamily: T.sans, color: color.text }}>{patient ? patient.name : (workspace.taskType === "data_entry" ? "Data Entry" : workspace.taskType === "inventory" ? "Inventory" : workspace.taskType || "Task")}</span>
          {workspace.rxPrescription?.rxNumber && (
            <span style={{ fontSize: 10, fontFamily: T.mono, color: `${color.bg}90`, background: `${color.bg}18`, padding: "2px 6px", borderRadius: 4 }}>
              Rx# {workspace.rxPrescription.rxNumber}
            </span>
          )}
          <span style={{ fontSize: 11, color: `${color.bg}80` }}>{color.name || ""}</span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {Object.entries(SNAP_SIZES).map(([key, size]) => {
            const isActive = tile.cols === size.cols && tile.rows === size.rows;
            const fillColor = isActive ? `${color.bg}90` : "#ffffff18";
            const strokeColor = isActive ? `${color.bg}` : "#ffffff35";
            return (
              <button key={key}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: "RESIZE_TILE", tileId: tile.id, size }); }}
                style={{
                  background: isActive ? `${color.bg}20` : "#ffffff08",
                  border: "none", borderRadius: T.radiusXs, color: T.textSecondary,
                  padding: "3px 4px", cursor: "pointer", display: "flex", alignItems: "center",
                  lineHeight: 0,
                }}
                title={size.label}
              >
                <svg width="18" height="12" viewBox={`0 0 ${GRID_COLS} ${GRID_ROWS}`} style={{ display: "block" }}>
                  <rect x="0" y="0" width={GRID_COLS} height={GRID_ROWS} rx="0.6"
                    fill="none" stroke="currentColor" strokeWidth="0.4" opacity="0.25" strokeDasharray="1 0.6" />
                  <rect x="0" y="0" width={size.cols} height={size.rows} rx="0.6"
                    fill={fillColor} stroke={strokeColor} strokeWidth="0.4" />
                </svg>
              </button>
            );
          })}
          <button onClick={(e) => { e.stopPropagation(); dispatch({ type: "CLOSE_WORKSPACE", workspaceId: workspace.id }); }}
            style={{ background: "#ffffff08", border: "none", borderRadius: T.radiusXs, color: T.textMuted, fontSize: 13, padding: "0 6px", cursor: "pointer", marginLeft: 4 }}>×</button>
        </div>
      </div>

      {/* Tab bar */}
      <div data-tab-bar="true" style={{
        display: "flex", alignItems: "center", background: T.tileBg,
        borderBottom: `1px solid rgba(255,255,255,0.04)`, overflowX: "auto", flexShrink: 0,
      }}>
        {openTabs.map(tab => {
          const tabType = TAB_TYPES[tab.type];
          const isActive = tab.id === tile.activeTabId;
          return (
            <div key={tab.id}
              onMouseDown={(e) => handleTabMouseDown(e, tab.id)}
              style={{
                padding: "9px 14px", fontSize: 12, fontFamily: T.sans,
                fontWeight: isActive ? 600 : 400, background: isActive ? T.surfaceRaised : "transparent",
                borderBottom: isActive ? `2px solid ${color.bg}` : "2px solid transparent",
                color: isActive ? T.textPrimary : T.textMuted, cursor: "grab",
                display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                userSelect: "none", transition: "all 0.15s ease",
              }}
            >
              <span style={{ fontSize: 9, fontWeight: 700, fontFamily: T.mono, opacity: 0.6, letterSpacing: 0.3 }}>{tabType?.icon}</span>
              {tabType?.label || tab.label}
              <span onClick={(e) => { e.stopPropagation(); dispatch({ type: "CLOSE_TAB", tileId: tile.id, tabId: tab.id }); }}
                style={{ fontSize: 11, opacity: 0.3, cursor: "pointer", padding: "0 2px" }}>×</span>
            </div>
          );
        })}
        {availableTabs.length > 0 && (
          <button onClick={(e) => { e.stopPropagation(); setShowTabSearch(prev => !prev); }}
            style={{
              background: showTabSearch ? T.surfaceRaised : "none",
              border: showTabSearch ? `1px solid ${T.surfaceBorder}` : "none",
              color: color.bg, fontSize: 18, cursor: "pointer", padding: "4px 12px",
              opacity: showTabSearch ? 1 : 0.5, fontWeight: 700, lineHeight: 1, borderRadius: T.radiusXs,
            }}>{showTabSearch ? "−" : "+"}</button>
        )}
      </div>

      {/* Content */}
      <div style={{
        flex: 1, overflow: "auto", background: T.surfaceRaised, color: T.textPrimary,
        position: "relative", minHeight: 0,
        scrollbarWidth: "thin", scrollbarColor: `${color.bg}30 transparent`,
      }}>
        {showTabSearch ? (
          <TabSearchPanel availableTabs={availableTabs} tileId={tile.id} color={color} onClose={() => setShowTabSearch(false)} />
        ) : (
          activeTab && <TabContent tab={activeTab} patient={patient} workspace={workspace} />
        )}
      </div>

      {/* Resize handles */}
      <div data-resize="true" onMouseDown={handleResizeMouseDown} style={{ position: "absolute", top: 0, right: -3, width: 6, height: "100%", cursor: "ew-resize", zIndex: 20 }} />
      <div data-resize="true" onMouseDown={handleResizeMouseDown} style={{ position: "absolute", bottom: -3, left: 0, height: 6, width: "100%", cursor: "ns-resize", zIndex: 20 }} />
      <div data-resize="true" onMouseDown={handleResizeMouseDown} style={{
        position: "absolute", bottom: -4, right: -4, width: 14, height: 14,
        cursor: "nwse-resize", zIndex: 30, borderRadius: 3, background: isResizing ? color.bg : "transparent",
      }}>
        {!isResizing && <div style={{ position: "absolute", bottom: 3, right: 3, width: 8, height: 8, opacity: 0.3, borderRight: `2px solid ${color.bg}`, borderBottom: `2px solid ${color.bg}` }} />}
      </div>
    </div>
  );
}


// ============================================================
// TAB SEARCH PANEL
// ============================================================
function TabSearchPanel({ availableTabs, tileId, color, onClose }) {
  const { dispatch } = useContext(PharmIDEContext);
  const [query, setQuery] = useState("");
  const [hlIndex, setHlIndex] = useState(0);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return availableTabs;
    const q = query.toLowerCase();
    return availableTabs.filter(tab => (TAB_TYPES[tab.type]?.label || tab.label || "").toLowerCase().includes(q))
      .sort((a, b) => {
        const aL = (TAB_TYPES[a.type]?.label || "").toLowerCase();
        const bL = (TAB_TYPES[b.type]?.label || "").toLowerCase();
        const q2 = query.toLowerCase();
        if (aL.startsWith(q2) && !bL.startsWith(q2)) return -1;
        if (!aL.startsWith(q2) && bL.startsWith(q2)) return 1;
        return 0;
      });
  }, [query, availableTabs]);

  useEffect(() => { setHlIndex(0); }, [query]);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  const handleSelect = (tab) => { dispatch({ type: "OPEN_TAB_IN_TILE", tileId, tabId: tab.id }); onClose(); };

  return (
    <div style={{ padding: 16 }}>
      <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHlIndex(i => Math.min(i + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHlIndex(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && filtered[hlIndex]) handleSelect(filtered[hlIndex]);
          else if (e.key === "Escape") onClose();
        }}
        placeholder="Search for a tab to open..."
        style={{
          width: "100%", padding: "10px 14px", borderRadius: 8,
          border: `2px solid ${color.border}80`, background: color.light,
          color: color.text, fontSize: 14, fontFamily: T.sans,
          outline: "none", boxSizing: "border-box",
        }}
      />
      <div style={{ marginTop: 8 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 14, color: T.textSecondary, fontSize: 13, textAlign: "center" }}>No matching tabs</div>
        ) : filtered.map((tab, i) => {
          const tabType = TAB_TYPES[tab.type];
          return (
            <div key={tab.id} onClick={(e) => { e.stopPropagation(); handleSelect(tab); }}
              onMouseEnter={() => setHlIndex(i)}
              style={{
                padding: "10px 14px", cursor: "pointer",
                background: i === hlIndex ? color.light : "transparent",
                border: i === hlIndex ? `1px solid ${color.border}40` : "1px solid transparent",
                borderRadius: 8, marginBottom: 2,
                display: "flex", alignItems: "center", gap: 10, transition: "all 0.1s ease",
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: T.mono, opacity: 0.5 }}>{tabType?.icon}</span>
              <div style={{ fontSize: 14, color: i === hlIndex ? color.text : T.textSecondary, fontWeight: i === hlIndex ? 600 : 400 }}>{tabType?.label}</div>
              {i === hlIndex && <span style={{ marginLeft: "auto", fontSize: 10, color: color.bg, fontFamily: T.mono, opacity: 0.7 }}>Enter ↵</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ============================================================
// PATIENT SEARCH DROPDOWN
// ============================================================
function NewPatientButton({ dispatch }) {
  const { storeDispatch } = useData();
  const handleClick = useCallback(() => {
    const id = crypto.randomUUID();
    storeDispatch({ type: 'ENTITY_UPDATED', entityType: 'patient', entityId: id, data: {
      id, name: "New Patient", firstName: "", lastName: "",
      dob: null, phone: null,
      address: null, address1: "", address2: "", city: "", state: "", zip: "",
      allergies: [], insurance: {}, medications: [], notes: "",
    }});
    dispatch({ type: 'CREATE_WORKSPACE', patientId: id, initialTabType: 'PATIENT_PROFILE' });
  }, [storeDispatch, dispatch]);

  return (
    <button onClick={handleClick} style={{
      width: "100%", padding: "7px 14px",
      display: "flex", alignItems: "center", gap: 6,
      background: "transparent", border: "none",
      borderLeft: `3px solid ${T.textMuted}30`,
      cursor: "pointer", color: T.textMuted,
      fontFamily: T.mono, fontSize: 10, fontWeight: 600,
      textAlign: "left", letterSpacing: 0.3,
      transition: "background 0.12s, border-left-color 0.12s, color 0.12s",
    }}
    onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = T.textSecondary; e.currentTarget.style.borderLeftColor = `${T.textMuted}60`; }}
    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.textMuted; e.currentTarget.style.borderLeftColor = `${T.textMuted}30`; }}
    >
      + New Patient
    </button>
  );
}

function PatientSearch({ openPatientIds, onSelect, sidebarMode }) {
  const { getEntities } = useData();
  const patients = getEntities('patient');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hlIndex, setHlIndex] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return patients;
    const q = query.toLowerCase();
    return [...patients].sort((a, b) => {
      const aName = a.name.toLowerCase(), bName = b.name.toLowerCase();
      const aStarts = aName.startsWith(q) || aName.split(" ").some(w => w.startsWith(q));
      const bStarts = bName.startsWith(q) || bName.split(" ").some(w => w.startsWith(q));
      if (aStarts && !bStarts) return -1; if (!aStarts && bStarts) return 1;
      return 0;
    }).filter(p => `${p.name} ${p.dob} ${p.phone} ${p.address}`.toLowerCase().includes(q));
  }, [query, patients]);

  useEffect(() => { setHlIndex(0); }, [query]);
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) { setOpen(false); setQuery(""); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (patient) => {
    if (!openPatientIds.includes(patient.id)) onSelect(patient.id);
    setOpen(false); setQuery("");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        background: "#5b8af510", border: `1px solid ${T.surfaceBorder}`,
        borderRadius: T.radiusSm, padding: "5px 14px", cursor: "pointer",
        color: "#5b8af5", fontSize: 12, fontFamily: T.sans,
        fontWeight: 500, display: "flex", alignItems: "center", gap: 6,
        width: sidebarMode ? "100%" : undefined, boxSizing: "border-box",
      }}><span style={{ fontSize: 14 }}>+</span> Open Patient</button>
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHlIndex(i => Math.min(i + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHlIndex(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && filtered[hlIndex]) handleSelect(filtered[hlIndex]);
          else if (e.key === "Escape") { setOpen(false); setQuery(""); }
        }}
        placeholder="Search patient..."
        style={{
          width: sidebarMode ? "100%" : 280, boxSizing: "border-box",
          padding: "6px 12px", borderRadius: T.radiusSm,
          border: `1px solid ${T.inputBorder}`, background: T.inputBg,
          color: T.textPrimary, fontSize: 12, fontFamily: T.sans, outline: "none",
        }}
      />
      <div style={{
        position: "absolute",
        top: sidebarMode ? "auto" : "calc(100% + 4px)",
        bottom: sidebarMode ? "calc(100% + 4px)" : "auto",
        left: 0,
        minWidth: sidebarMode ? 240 : undefined, right: sidebarMode ? "auto" : 0,
        background: T.surfaceRaised, border: `1px solid ${T.surfaceBorder}`, borderRadius: T.radiusSm,
        overflow: "hidden", zIndex: 500, boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        maxHeight: 240, overflowY: "auto",
      }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "12px 16px", color: T.textSecondary, fontSize: 12, textAlign: "center" }}>No patients found</div>
        ) : filtered.map((patient, i) => {
          const isOpen = openPatientIds.includes(patient.id);
          return (
            <div key={patient.id} onClick={() => handleSelect(patient)} onMouseEnter={() => setHlIndex(i)}
              style={{
                padding: "8px 14px", cursor: isOpen ? "default" : "pointer",
                background: i === hlIndex ? T.surfaceHover : "transparent",
                borderBottom: `1px solid ${T.surfaceBorder}20`, opacity: isOpen ? 0.4 : 1,
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary }}>
                  {patient.name}{isOpen && <span style={{ marginLeft: 8, fontSize: 10, color: T.textMuted }}>● open</span>}
                </div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2, fontFamily: T.mono }}>
                  DOB: {patient.dob} · {patient.phone}
                </div>
              </div>
              {!isOpen && i === hlIndex && <span style={{ fontSize: 10, color: "#60a5fa", fontFamily: T.mono }}>Enter ↵</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ============================================================
// MAIN APP
// ============================================================
// ============================================================
// HAIKU E-SCRIPT GENERATOR — dev/demo tool
// ============================================================
const INTERVALS = [[10000,'10s'],[30000,'30s'],[60000,'1m'],[120000,'2m']];


function EScriptGeneratorPanel() {
  const data = useDataProvider();
  const { storeDispatch } = useData();
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem('pharmide_haiku_key') || ''; } catch { return ''; }
  });
  const [intervalMs, setIntervalMs] = useState(30000);
  const [isRunning, setIsRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [generating, setGenerating] = useState(false);
  const timerRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    try { if (apiKey) localStorage.setItem('pharmide_haiku_key', apiKey); } catch { /* */ }
  }, [apiKey]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const generateOne = useCallback(async () => {
    if (!apiKey.trim()) return;
    setGenerating(true);
    try {
      // Rust picks a random drug from haiku-drug-database.json and passes the exact NDC to Haiku.
      const raw = await data.generateEScripts(apiKey.trim());
      // Strip markdown code fences if the model wrapped the output anyway
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const { patient, prescriber, drug } = JSON.parse(text);
      const patientId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const messageId = `MSG-GEN-${Date.now()}`;
      const now = new Date().toISOString();
      const dobFmt = `${patient.dob.slice(4,6)}/${patient.dob.slice(6,8)}/${patient.dob.slice(0,4)}`;

      const patientEntry = {
        id: patientId,
        name: `${patient.firstName} ${patient.lastName}`,
        firstName: patient.firstName,
        lastName: patient.lastName,
        dob: dobFmt,
        gender: patient.gender,
        address: patient.address,
        city: patient.city,
        state: patient.state,
        zip: patient.zip,
        phone: patient.phone,
        allergies: [],
        medications: [],
        insurance: {},
        notes: '',
        isNewPatient: true,
      };

      const eorderEntry = {
        id: messageId,
        patientId,
        messageId,
        receivedAt: now,
        raw: {
          messageType: 'NEWRX',
          drugDescription: `${drug.brandName} ${drug.strength} ${drug.form}`,
          drugNDC: drug.ndc,
          drugCodedName: drug.genericName,
          drugStrength: drug.strength,
          drugForm: drug.form,
          drugQuantity: String(drug.quantity),
          drugDaysSupply: String(drug.daysSupply),
          refillsAuthorized: String(drug.refills),
          substitutionCode: String(drug.substitutionCode),
          sigText: drug.sigText,
          sigCode: drug.sigCode,
          prescriberLastName: prescriber.lastName,
          prescriberFirstName: prescriber.firstName,
          prescriberDEA: prescriber.dea,
          prescriberNPI: prescriber.npi,
          prescriberPhone: prescriber.phone,
          prescriberAddress: prescriber.practice,
          patientLastName: patient.lastName,
          patientFirstName: patient.firstName,
          patientDOB: patient.dob,
          dateWritten: now.slice(0,10).replace(/-/g,''),
          note: '',
        },
        transcribed: {
          drug: `${drug.brandName} (${drug.genericName}) ${drug.strength}`,
          sig: drug.sigText.charAt(0) + drug.sigText.slice(1).toLowerCase(),
          qty: drug.quantity,
          daySupply: drug.daysSupply,
          refills: drug.refills,
          daw: drug.substitutionCode,
          prescriber: `Dr. ${prescriber.firstName} ${prescriber.lastName}, ${prescriber.suffix}`,
          prescriberDEA: prescriber.dea,
          dateWritten: `${patient.dob.slice(4,6)}/${patient.dob.slice(6,8)}/${now.slice(0,4)}`,
          patient: `${patient.firstName} ${patient.lastName}`,
          patientDOB: dobFmt,
          deaSchedule: drug.deaSchedule,
        },
      };

      // Write to runtime registry (for getEOrder / Tauri fallback) and store (for reactive queue)
      RUNTIME_EORDERS[patientId] = eorderEntry;
      storeDispatch({ type: 'ENTITY_UPDATED', entityType: 'patient', entityId: patientId, data: patientEntry });
      storeDispatch({ type: 'ENTITY_UPDATED', entityType: 'eorder', entityId: messageId, data: eorderEntry });

      setLog(prev => [{
        ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        drug: `${drug.brandName} ${drug.strength}`,
        patient: `${patient.firstName} ${patient.lastName}`,
        schedule: drug.deaSchedule,
      }, ...prev].slice(0, 25));

    } catch (err) {
      setLog(prev => [{
        ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        error: String(err.message || err),
      }, ...prev].slice(0, 25));
    } finally {
      setGenerating(false);
    }
  }, [apiKey, data, storeDispatch]);

  // Start / stop interval
  useEffect(() => {
    if (!isRunning) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    generateOne();
    timerRef.current = setInterval(generateOne, intervalMs);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [isRunning, intervalMs, generateOne]);

  const handleToggle = () => {
    if (!apiKey.trim()) { setOpen(true); return; }
    setIsRunning(r => !r);
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 10px', borderRadius: T.radiusSm,
          border: `1px solid ${isRunning ? '#4abe6a40' : '#ffffff18'}`,
          background: isRunning ? '#4abe6a12' : 'transparent',
          color: isRunning ? '#4abe6a' : T.textMuted,
          cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: T.mono,
          letterSpacing: 0.5,
        }}
      >
        {isRunning && (
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: '#4abe6a', flexShrink: 0,
            boxShadow: '0 0 0 0 #4abe6a', animation: 'escriptPulse 1.4s ease-in-out infinite',
          }} />
        )}
        ⚡ E-Scripts
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, width: 320, zIndex: 600,
          background: T.surfaceRaised, border: `1px solid ${T.surfaceBorder}`,
          borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.55)', overflow: 'hidden',
        }}>
          {/* Controls */}
          <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${T.surfaceBorder}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textPrimary, fontFamily: T.mono, marginBottom: 10 }}>
              Haiku E-Script Generator
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, color: T.textMuted, fontFamily: T.mono, letterSpacing: '0.08em', marginBottom: 3 }}>API KEY</div>
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                style={{
                  width: '100%', padding: '5px 8px', borderRadius: 5, boxSizing: 'border-box',
                  border: `1px solid ${T.inputBorder}`, background: T.surfaceBase,
                  color: T.textPrimary, fontSize: 11, fontFamily: T.mono, outline: 'none',
                }}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: T.textMuted, fontFamily: T.mono, letterSpacing: '0.08em', marginBottom: 3 }}>INTERVAL</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {INTERVALS.map(([ms, label]) => (
                  <button key={ms} onClick={() => setIntervalMs(ms)} style={{
                    flex: 1, padding: '4px 0', borderRadius: 4, cursor: 'pointer',
                    border: `1px solid ${intervalMs === ms ? '#5b8af5' : T.inputBorder}`,
                    background: intervalMs === ms ? '#5b8af520' : 'transparent',
                    color: intervalMs === ms ? '#5b8af5' : T.textMuted,
                    fontSize: 10, fontFamily: T.mono, fontWeight: intervalMs === ms ? 700 : 400,
                  }}>{label}</button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={handleToggle}
                disabled={!apiKey.trim()}
                style={{
                  flex: 1, padding: '6px 0', borderRadius: 5, border: 'none',
                  cursor: apiKey.trim() ? 'pointer' : 'not-allowed',
                  background: !apiKey.trim() ? '#ffffff10' : isRunning ? '#f87171' : '#4abe6a',
                  color: !apiKey.trim() ? T.textMuted : '#fff',
                  fontWeight: 700, fontSize: 11, fontFamily: T.mono,
                }}
              >
                {isRunning ? '⏹ Stop' : '▶ Start'}
              </button>
              <button
                onClick={() => { if (apiKey.trim() && !generating) generateOne(); }}
                disabled={generating || !apiKey.trim()}
                style={{
                  padding: '6px 12px', borderRadius: 5, border: `1px solid ${T.inputBorder}`,
                  background: 'transparent', cursor: (generating || !apiKey.trim()) ? 'not-allowed' : 'pointer',
                  color: T.textSecondary, fontWeight: 600, fontSize: 11, fontFamily: T.mono,
                }}
              >
                {generating ? '…' : 'Once'}
              </button>
            </div>
          </div>

          {/* Log */}
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {log.length === 0 ? (
              <div style={{ padding: '10px 14px', fontSize: 11, color: T.textMuted, fontFamily: T.mono }}>
                No scripts generated yet
              </div>
            ) : log.map((entry, i) => (
              <div key={i} style={{
                padding: '6px 14px', borderBottom: `1px solid ${T.surfaceBorder}`,
                display: 'flex', alignItems: 'flex-start', gap: 8,
              }}>
                <span style={{ fontSize: 9, color: T.textMuted, fontFamily: T.mono, flexShrink: 0, paddingTop: 1 }}>{entry.ts}</span>
                {entry.error ? (
                  <span style={{ fontSize: 11, color: '#f87171', fontFamily: T.mono, wordBreak: 'break-word' }}>{entry.error}</span>
                ) : (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: T.textPrimary, fontFamily: T.mono }}>{entry.drug}</span>
                      {entry.schedule !== 'general' && (
                        <span style={{ fontSize: 9, fontWeight: 800, color: '#e8a030', background: '#1f1a14', border: '1px solid #3d3020', padding: '0 4px', borderRadius: 2 }}>
                          {entry.schedule.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono }}>{entry.patient}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


export default function PharmIDE() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const mockProvider = useMemo(() => createMockDataProvider(), []);
  const dataProvider = useMemo(() => {
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
      return createTauriDataProvider(mockProvider);
    }
    return mockProvider;
  }, [mockProvider]);
  const [currentUser, setCurrentUser] = useState(null); // { id, name, role }
  const [users, setUsers] = useState([]);
  const [chainStatus, setChainStatus] = useState(null); // null | { valid, totalChecked, brokenAt }
  const currentRole = currentUser?.role || "tech";

  // Load users from backend on startup
  useEffect(() => {
    dataProvider.getUsers().then(u => { if (u?.length) setUsers(u); });
  }, [dataProvider]);

  // On login: start a session, then run a background chain verification.
  useEffect(() => {
    if (!currentUser) return;
    dataProvider.verifyAuditChain().then(result => {
      if (result) setChainStatus(result);
    });
  }, [currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prescription startup loading handled by <AppStartup /> inside DataProvider.

  const canDo = useCallback((action) => {
    const permissions = {
      tech: ["SUBMIT_RX", "RESUBMIT_RX", "RESET_RX", "START_FILL", "SUBMIT_FILL", "CREATE_WORKSPACE", "rx_entry", "fill"],
      rph:  ["RPH_APPROVE", "RPH_RETURN", "RPH_CALL", "RESOLVE_CALL", "RPH_VERIFY_FILL", "RPH_REJECT_FILL", "CREATE_WORKSPACE", "rph_verify", "fill_verify",
             "SUBMIT_RX", "RESUBMIT_RX", "RESET_RX", "START_FILL", "SUBMIT_FILL", "rx_entry", "fill"],
    };
    return (permissions[currentRole] || []).includes(action);
  }, [currentRole]);
  const contextValue = useMemo(() => ({ state, dispatch, currentRole, currentUser, canDo, neutralMode: state.neutralMode }), [state, currentRole, currentUser, canDo]);

  const activePage = state.activePageId ? state.pages[state.activePageId] : null;
  const activeWorkspace = activePage ? state.workspaces[activePage.workspaceId] : null;
  const tileEntries = Object.values(state.tiles).filter(t => t.pageId === state.activePageId);

  // Split pages into patient workspaces (top bar) and task workspaces (sidebar)
  const patientPages = state.pageOrder.filter(pid => !!state.workspaces[state.pages[pid]?.workspaceId]?.patientId);
  const taskPages    = state.pageOrder.filter(pid => {
    const ws = state.workspaces[state.pages[pid]?.workspaceId];
    return ws?.taskType && !ws?.patientId;
  });
  const TASK_META = {
    data_entry:    { label: "Data Entry",  color: "#5b8af5" },
    inventory:     { label: "Inventory",   color: "#40c0b0" },
    rx_history:    { label: "Rx History",  color: "#9b7fe8" },
    pickup:        { label: "Pickup",      color: "#38bdf8" },
    prescriber_dir:       { label: "Prescribers",  color: "#c084fc" },
    patient_maintenance:  { label: "Patients",      color: "#f97316" },
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "k"))) return;
      e.preventDefault();
      if (e.key === "ArrowRight") { if (state.pageOrder.length > 1) dispatch({ type: "NAVIGATE_PAGE", direction: "next" }); }
      else if (e.key === "ArrowLeft") { if (state.pageOrder.length > 1) dispatch({ type: "NAVIGATE_PAGE", direction: "prev" }); }
      else if (e.key === "ArrowDown") { dispatch({ type: "NAVIGATE_TASK_PAGE", direction: "next" }); }
      else if (e.key === "ArrowUp") { dispatch({ type: "NAVIGATE_TASK_PAGE", direction: "prev" }); }
      else if (e.key === "k") { dispatch({ type: "SWITCH_TAB_GROUP" }); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.pageOrder.length]);

  const handleGridDrop = useCallback((e) => {
    e.preventDefault();
    const tabId = e.dataTransfer.getData("tabId");
    const fromTileId = e.dataTransfer.getData("fromTileId");
    const tabCount = parseInt(e.dataTransfer.getData("tabCount") || "0", 10);
    if (!tabId || !fromTileId) return;
    const gridEl = e.currentTarget, gridRect = gridEl.getBoundingClientRect();
    const cellW = gridRect.width / GRID_COLS, cellH = gridRect.height / GRID_ROWS;
    const col = Math.round((e.clientX - gridRect.left) / cellW - 3);
    const row = Math.round((e.clientY - gridRect.top) / cellH - 2);
    if (tabCount <= 1) { dispatch({ type: "MOVE_TILE", tileId: fromTileId, col, row }); return; }
    dispatch({ type: "DETACH_TAB", tileId: fromTileId, tabId, col, row });
  }, []);

  const handleGridDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; }, []);

  return (
    <PharmIDEContext.Provider value={contextValue}>
      <DataProviderContext.Provider value={dataProvider}>
      <DataProvider backendProvider={dataProvider}>
        <AppStartup />
        <div style={{
          width: "100vw", height: "100vh", maxHeight: "100vh",
          display: "flex", flexDirection: "row",
          background: "#0f1117", fontFamily: T.sans, overflow: "hidden",
          position: "fixed", top: 0, left: 0,
        }}>

          {/* ── Left Sidebar ── */}
          <div style={{
            width: 160, flexShrink: 0,
            background: T.surface, boxShadow: "1px 0 0 rgba(255,255,255,0.05)",
            display: "flex", flexDirection: "column",
          }}>
            {/* Logo */}
            <div style={{ padding: "14px 14px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
              <div style={{ fontWeight: 800, fontSize: 15, fontFamily: T.mono, letterSpacing: -0.5 }}>
                <span style={{ color: "#5b8af5" }}>Pharm</span><span style={{ color: T.textSecondary }}>IDE</span>
              </div>
              <div style={{ fontSize: 9, color: T.textMuted, fontFamily: T.mono, marginTop: 2 }}>v0.3</div>
            </div>

            {/* User info */}
            {currentUser && (
              <div style={{ padding: "10px 12px", borderBottom: `1px solid ${T.surfaceBorder}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                  <span style={{
                    fontSize: 9, fontFamily: T.mono, fontWeight: 700, letterSpacing: 0.5,
                    color: currentRole === "rph" ? "#4abe6a" : "#5b8af5",
                    background: currentRole === "rph" ? "#4abe6a18" : "#5b8af518",
                    border: `1px solid ${currentRole === "rph" ? "#4abe6a30" : "#5b8af530"}`,
                    borderRadius: T.radiusXs, padding: "1px 5px",
                  }}>
                    {currentRole.toUpperCase()}
                  </span>
                  <button onClick={async () => { await dataProvider.endSession(); setCurrentUser(null); setChainStatus(null); }} style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: T.textMuted, fontSize: 9, fontFamily: T.mono, padding: 0,
                    textDecoration: "underline", marginLeft: "auto",
                  }}>switch</button>
                </div>
                <div style={{ fontSize: 11, color: T.textSecondary, fontFamily: T.sans, lineHeight: 1.3 }}>
                  {currentUser.name}
                </div>
                {chainStatus !== null && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 5 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: chainStatus.valid ? "#4abe6a" : "#f87171", flexShrink: 0 }} />
                    <span style={{ fontSize: 9, fontFamily: T.mono, color: chainStatus.valid ? T.textMuted : "#f87171" }}>
                      {chainStatus.valid ? `chain ok · ${chainStatus.totalChecked}` : "chain broken!"}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Open task workspace tabs (live navigation) */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              {taskPages.length === 0 ? (
                <div style={{ padding: "16px 14px", fontSize: 10, color: T.textMuted, fontFamily: T.mono, opacity: 0.45, lineHeight: 1.5 }}>
                  No workspaces open.<br />Use New below.
                </div>
              ) : taskPages.map(pageId => {
                const page = state.pages[pageId];
                const ws = state.workspaces[page?.workspaceId];
                const isActive = pageId === state.activePageId;
                const meta = TASK_META[ws?.taskType] || { label: page?.label || "Workspace", color: T.textMuted };
                const mc = state.neutralMode ? NEUTRAL_TASK_COLOR : meta.color;
                return (
                  <button key={pageId}
                    onClick={() => dispatch({ type: "SET_ACTIVE_PAGE", pageId })}
                    style={{
                      width: "100%", padding: "10px 14px",
                      display: "flex", alignItems: "center", gap: 8,
                      background: isActive ? `${mc}15` : "transparent",
                      border: "none",
                      borderLeft: `3px solid ${isActive ? mc : `${mc}40`}`,
                      cursor: "pointer",
                      color: isActive ? T.textPrimary : T.textSecondary,
                      fontFamily: T.mono, fontSize: 11, fontWeight: isActive ? 600 : 400,
                      textAlign: "left", transition: "background 0.12s",
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = `${mc}0e`; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: mc, flexShrink: 0, opacity: isActive ? 1 : 0.5 }} />
                    {meta.label}
                  </button>
                );
              })}
            </div>

            {/* Create new task workspace buttons */}
            <div style={{ borderTop: `1px solid ${T.surfaceBorder}`, paddingTop: 4, paddingBottom: 4 }}>
              <div style={{ padding: "5px 14px 2px", fontSize: 8, color: T.textMuted, fontFamily: T.mono, letterSpacing: "0.1em", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>NEW</span>
                <button
                  onClick={() => dispatch({ type: "TOGGLE_NEUTRAL_MODE" })}
                  title={state.neutralMode ? "Color mode" : "Neutral mode (accessibility)"}
                  style={{
                    background: state.neutralMode ? "rgba(255,255,255,0.12)" : "transparent",
                    border: "none", borderRadius: 4, cursor: "pointer",
                    color: state.neutralMode ? T.textPrimary : T.textMuted,
                    fontSize: 10, padding: "1px 5px", lineHeight: 1,
                  }}
                >⊘</button>
              </div>
              {Object.entries(TASK_META).map(([type, { label, color }]) => {
                const bc = state.neutralMode ? NEUTRAL_TASK_COLOR : color;
                return (
                <button key={type}
                  onClick={() => dispatch({ type: "CREATE_TASK_WORKSPACE", taskType: type })}
                  style={{
                    width: "100%", padding: "7px 14px",
                    display: "flex", alignItems: "center",
                    background: "transparent", border: "none",
                    borderLeft: `3px solid ${bc}30`,
                    cursor: "pointer", color: bc,
                    fontFamily: T.mono, fontSize: 10, fontWeight: 600,
                    textAlign: "left", letterSpacing: 0.3,
                    transition: "background 0.12s, border-left-color 0.12s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = `${bc}10`; e.currentTarget.style.borderLeftColor = `${bc}80`; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderLeftColor = `${bc}30`; }}
                >
                  + {label}
                </button>
                );
              })}
              <div style={{ padding: "4px 11px 2px" }}>
                <EScriptGeneratorPanel />
              </div>
            </div>

            {/* Patient Search + New Patient pinned at sidebar bottom */}
            <div style={{ borderTop: `1px solid ${T.surfaceBorder}`, paddingTop: 4, paddingBottom: 8 }}>
              <NewPatientButton dispatch={dispatch} />
              <div style={{ padding: "0 8px" }}>
              <PatientSearch
                openPatientIds={Object.values(state.workspaces).map(w => w.patientId)}
                onSelect={(patientId) => dispatch({ type: "CREATE_WORKSPACE", patientId })}
                sidebarMode={true}
              />
              </div>
            </div>
          </div>

          {/* ── Right Main Area ── */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Top Bar — patient workspace page strip only */}
            <div style={{
              height: 40, background: T.bg, boxShadow: "0 1px 0 rgba(255,255,255,0.05)",
              display: "flex", alignItems: "center", padding: "0 6px", flexShrink: 0, gap: 2,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 2, flex: 1, overflow: "hidden" }}>
                {patientPages.length === 0 && (
                  <span style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono, padding: "0 8px", opacity: 0.45 }}>
                    No patient workspaces open — search for a patient in the sidebar
                  </span>
                )}
                {patientPages.map((pageId, idx) => {
                  const page = state.pages[pageId];
                  const ws = state.workspaces[page.workspaceId];
                  const isActive = pageId === state.activePageId;
                  const c = state.neutralMode ? NEUTRAL_WS_COLOR : ws?.color;
                  return (
                    <button key={pageId} onClick={() => dispatch({ type: "SET_ACTIVE_PAGE", pageId })}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "5px 10px 5px 12px", borderRadius: T.radiusSm, cursor: "pointer",
                        border: isActive ? `1px solid ${c?.bg || T.textMuted}40` : "1px solid transparent",
                        background: isActive ? `${c?.bg || T.textMuted}15` : "transparent",
                        transition: "all 0.15s ease", flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: c?.bg || T.textMuted, opacity: isActive ? 0.9 : 0.4 }} />
                      <span style={{ fontSize: 12, fontWeight: isActive ? 600 : 400, color: isActive ? T.textPrimary : T.textMuted, fontFamily: T.sans }}>
                        <PatientName patientId={ws.patientId} fallback={page.label || "Patient"} />
                      </span>
                      <span
                        onClick={(e) => { e.stopPropagation(); dispatch({ type: "CLOSE_WORKSPACE", workspaceId: ws.id }); }}
                        style={{
                          fontSize: 14, lineHeight: 1, padding: "0 3px",
                          color: T.textMuted, opacity: 0.45, cursor: "pointer",
                          borderRadius: 3, transition: "opacity 0.1s",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "#f87171"; }}
                        onMouseLeave={e => { e.currentTarget.style.opacity = "0.45"; e.currentTarget.style.color = T.textMuted; }}
                        title="Close workspace"
                      >×</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* User Picker Modal */}
            {!currentUser && (
              <div style={{
                position: "fixed", inset: 0, zIndex: 9999,
                background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <div style={{
                  background: T.surfaceRaised, border: `1px solid ${T.surfaceBorder}`,
                  borderRadius: 14, padding: "32px 28px", width: 340,
                  boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
                }}>
                  <div style={{ fontFamily: T.mono, fontWeight: 800, fontSize: 15, color: T.textPrimary, marginBottom: 4 }}>
                    <span style={{ color: "#5b8af5" }}>Pharm</span><span style={{ color: T.textSecondary }}>IDE</span>
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, fontFamily: T.sans, marginBottom: 24 }}>
                    Select your user to begin
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {(users.length ? users : [
                      { id: "usr-tech-1", name: "Alex Chen", role: "tech" },
                      { id: "usr-tech-2", name: "Jordan Mills", role: "tech" },
                      { id: "usr-rph-1", name: "Dr. Sarah Park", role: "rph" },
                      { id: "usr-rph-2", name: "Dr. Marcus Webb", role: "rph" },
                    ]).map(user => (
                      <button key={user.id} onClick={async () => { await dataProvider.startSession(user.id, user.role); setCurrentUser(user); }}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "12px 16px", borderRadius: 10, cursor: "pointer",
                          background: T.surface, border: `1px solid ${T.surfaceBorder}`,
                          transition: "all 0.15s ease", textAlign: "left",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = user.role === "rph" ? "#4abe6a50" : "#5b8af550"; e.currentTarget.style.background = T.surfaceHover; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = T.surfaceBorder; e.currentTarget.style.background = T.surface; }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, fontFamily: T.sans }}>{user.name}</span>
                        <span style={{
                          fontSize: 10, fontFamily: T.mono, fontWeight: 700, letterSpacing: 0.5,
                          padding: "2px 8px", borderRadius: 4,
                          background: user.role === "rph" ? "#4abe6a18" : "#5b8af518",
                          color: user.role === "rph" ? "#4abe6a" : "#5b8af5",
                          border: `1px solid ${user.role === "rph" ? "#4abe6a30" : "#5b8af530"}`,
                        }}>
                          {user.role.toUpperCase()}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Grid Area */}
            <div data-grid="true" onDrop={handleGridDrop} onDragOver={handleGridDragOver}
              style={{
                flex: 1, minHeight: 0, display: "grid",
                gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
                gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
                gap: 6, padding: 8, position: "relative", background: T.bg,
              }}
            >
              {Array.from({ length: GRID_COLS * GRID_ROWS }).map((_, i) => (
                <div key={`cell-${i}`} style={{
                  gridColumn: `${(i % GRID_COLS) + 1}`, gridRow: `${Math.floor(i / GRID_COLS) + 1}`,
                  borderRadius: T.radiusXs, border: `1px solid ${T.surfaceBorder}20`,
                  pointerEvents: "none",
                }} />
              ))}

              {tileEntries.map(tile => {
                const workspace = state.workspaces[tile.workspaceId];
                if (!workspace) return null;
                if (!workspace.patientId && !workspace.taskType) return null;
                return <Tile key={tile.id} tile={tile} workspace={workspace} />;
              })}

              {!state.activePageId && (
                <div style={{
                  gridColumn: "3 / span 6", gridRow: "3 / span 4",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: T.textMuted,
                }}>
                  <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.2, fontFamily: T.mono }}>+</div>
                  <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, fontFamily: T.sans }}>No patient workspaces open</div>
                  <div style={{ fontSize: 13, opacity: 0.5, textAlign: "center", lineHeight: 1.6, fontFamily: T.sans }}>
                    Search for a patient in the sidebar to begin.<br />Each patient gets their own grid page.
                  </div>
                </div>
              )}
            </div>

            {/* ── Queue Bar ── */}
            <QueueBar
              state={state}
              currentRole={currentRole}
              onRxClick={(workspaceId, tabType) => {
                const ws = state.workspaces[workspaceId];
                if (!ws) return;
                const page = Object.values(state.pages).find(p => p.workspaceId === workspaceId);
                if (page) {
                  dispatch({ type: "SET_ACTIVE_PAGE", pageId: page.id });
                  const tile = Object.values(state.tiles).find(t => t.workspaceId === workspaceId);
                  if (tile) {
                    const tab = ws.tabs.find(t => t.type === tabType);
                    if (tab) dispatch({ type: "OPEN_TAB_IN_TILE", tileId: tile.id, tabId: tab.id });
                  }
                }
              }}
            />

            {/* Status Bar */}
            <div style={{
              height: 28, background: T.bg, borderTop: `1px solid ${T.surfaceBorder}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "0 12px", flexShrink: 0,
              fontFamily: T.mono, fontSize: 10, color: T.textMuted,
            }}>
              <div style={{ display: "flex", gap: 16 }}>
                <span>Pages: {state.pageOrder.length}</span>
                <span>Tiles: {tileEntries.length}</span>
                {activeWorkspace && (
                  <span style={{ color: activeWorkspace.color.bg }}>
                    ● <PatientName patientId={activeWorkspace.patientId} />
                  </span>
                )}
              </div>
              <div>Ctrl+← → patient workspaces · Ctrl+↑ ↓ task workspaces · Drag tabs to detach · Drop on tiles to merge</div>
            </div>

          </div>{/* end right main */}
        </div>
      </DataProvider>
      </DataProviderContext.Provider>
    </PharmIDEContext.Provider>
  );
}
