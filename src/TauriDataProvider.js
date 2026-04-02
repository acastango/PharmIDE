// TauriDataProvider.js
//
// Drop-in replacement for createMockDataProvider() in PharmIDE.jsx.
// Same interface, calls Tauri Rust backend for drug data.
//
// Usage in PharmIDE.jsx:
//   import { createTauriDataProvider } from './TauriDataProvider';

const isTauri = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
let _invoke;
async function getInvoke() {
  if (_invoke) return _invoke;
  if (isTauri()) {
    const t = await import('@tauri-apps/api/core');
    _invoke = t.invoke;
  } else {
    _invoke = async () => null;
  }
  return _invoke;
}
async function invoke(cmd, args) { return (await getInvoke())(cmd, args); }

// ─── Format strength with dosage form ─────────────────────────────────
// FDA: "25/1" + "tablet" → "25mg tablet"
//      "500/5" + "oral solution" → "500mg/5ml oral solution"
function formatStrengthWithForm(rawStrength, form) {
  if (!rawStrength) return '';
  const s = rawStrength.trim();
  const f = (form || '').toLowerCase();

  // Already has units? Check if form info would be redundant
  if (/[a-zA-Z]/.test(s)) {
    const sLower = s.toLowerCase();
    if (sLower.includes('tablet') || sLower.includes('capsule') ||
        sLower.includes('solution') || sLower.includes('ml')) {
      return s;
    }
    return `${s} ${form}`;
  }

  const slashMatch = s.match(/^([\d.]+)\/([\d.]+)$/);
  if (slashMatch) {
    const num = slashMatch[1];
    const denom = slashMatch[2];

    // Liquids: 500/5 → "500mg/5ml"
    if (f.includes('solution') || f.includes('suspension') || f.includes('syrup') ||
        f.includes('elixir') || f.includes('liquid')) {
      if (parseFloat(denom) > 1) {
        return `${num}mg/${denom}ml ${form}`;
      }
      return `${num}mg ${form}`;
    }

    // Solid /1 = per unit: "25/1" → "25mg"
    if (denom === '1') {
      return `${num}mg ${form}`;
    }

    // Combo: "5/25" tablet → "5/25mg tablet"
    return `${num}/${denom}mg ${form}`;
  }

  // Plain number
  if (/^[\d.]+$/.test(s)) {
    return `${s}mg ${form}`;
  }

  return `${s} ${form}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function safeParseJson(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; }
  catch { return fallback; }
}

// ─── Provider ─────────────────────────────────────────────────────────

export function createTauriDataProvider(mockFallback) {

  return {
    // ── Drug search — LIGHTWEIGHT, no manufacturer/NDC loading ──
    searchDrugs: async (query, limit = 12) => {
      if (!query || query.length < 2) return [];

      const parts = query.split(",").map(p => p.trim()).filter(Boolean);
      const nameQ = parts[0] || null;
      const strengthQ = parts[1] || null;
      const formQ = parts[2] || null;

      if (!nameQ || nameQ.length < 2) return [];

      try {
        // Uses search_drugs_fast — just drug/strength/form, no nested queries
        const hits = await invoke('search_drugs_fast', {
          drugName: nameQ,
          dose: strengthQ,
          form: formQ,
          limit: 50,
        });

        if (!hits || hits.length === 0) return [];

        // Group by drug_id + displayStrength — one entry per specific form.
        // This keeps "500mg tablet" and "500mg tablet, extended release" as
        // separate selectable items so the user always picks an exact form.
        const nameQLower = nameQ.toLowerCase();
        const drugMap = new Map();
        for (const hit of hits) {
          const displayStrength = formatStrengthWithForm(hit.strength, hit.form);
          const key = `${hit.drugId}\x00${displayStrength}`;
          if (drugMap.has(key)) continue;

          let score = 0;
          const name = hit.drugName.toLowerCase();
          if (name === nameQLower) score -= 100;
          else if (name.startsWith(nameQLower)) score -= 50;
          else if (name.split(/[\s\-\/]/).some(w => w.startsWith(nameQLower))) score -= 30;
          else if (name.includes(nameQLower)) score -= 20;
          if (strengthQ && displayStrength.toLowerCase().includes(strengthQ.toLowerCase())) score -= 5;

          drugMap.set(key, {
            id: `db-${hit.drugId}`,
            _backendId: hit.drugId,
            name: hit.drugName,
            brandNames: [],
            strengths: [displayStrength],
            form: hit.form,
            route: hit.route || 'oral',
            schedule: hit.deaSchedule || 'Rx',
            drugClass: hit.drugClass || '',
            _matchedStrength: displayStrength,
            _score: score,
          });
        }

        return Array.from(drugMap.values())
          .sort((a, b) => a._score - b._score || a.name.localeCompare(b.name))
          .slice(0, limit);
      } catch (e) {
        console.error('Tauri searchDrugs failed:', e);
        return mockFallback?.searchDrugs(query) || [];
      }
    },

    // ── Get drug by ID (sync — drug object stored in PharmIDE state) ──
    getDrug: (id) => {
      if (typeof id === 'string' && id.startsWith('db-')) {
        return null;
      }
      return mockFallback?.getDrug(id) || null;
    },

    // ── Get products for drug + strength ──
    // Uses lightweight chain: get_strengths → get_forms → get_products
    getProductsForDrug: async (drugId, strength) => {
      const backendId = typeof drugId === 'string' && drugId.startsWith('db-')
        ? parseInt(drugId.replace('db-', ''), 10) : null;

      if (!backendId) {
        return mockFallback?.getProductsForDrug(drugId, strength) || [];
      }

      try {
        const strengths = await invoke('get_strengths', { drugId: backendId });
        if (!strengths || strengths.length === 0) return [];

        // Match selected display strength back to raw DB strength
        // Display: "25mg tablet" — DB has: "25/1"
        let matchingStrengths = strengths;
        if (strength) {
          const sLower = strength.toLowerCase();
          const numMatch = sLower.match(/^([\d.\/]+)/);
          const numPart = numMatch ? numMatch[1] : sLower;

          matchingStrengths = strengths.filter(s => {
            const raw = s.strength.toLowerCase();
            // Match "25" against "25/1", or "500/5" against "500/5"
            return raw.includes(numPart) || numPart.includes(raw);
          });

          if (matchingStrengths.length === 0) {
            matchingStrengths = strengths.filter(s =>
              s.strength.toLowerCase().includes(sLower) ||
              sLower.includes(s.strength.toLowerCase())
            );
          }
        }

        const products = [];
        for (const s of matchingStrengths) {
          const forms = await invoke('get_forms', { strengthId: s.id });
          if (!forms) continue;

          for (const f of forms) {
            const displayStrength = formatStrengthWithForm(s.strength, f.form);

            // Only load NDCs for the form that exactly matches what was selected.
            // Prevents "tablet" NDCs from appearing when "tablet, extended release" was chosen.
            if (strength && displayStrength.toLowerCase().trim() !== strength.toLowerCase().trim()) continue;

            // Get NDC-level products (one row per package)
            const dispensable = await invoke('get_dispensable_products', { formId: f.id });
            if (!dispensable) continue;

            for (const dp of dispensable) {
              const pkgLabel = dp.packageSize
                ? `${Math.round(dp.packageSize)}${dp.packageUnit || 'EA'}`
                : (dp.packageDesc || '');
              products.push({
                id: `ndc-${dp.ndcId}`,
                drugId,
                ndc: dp.ndc,
                strength: displayStrength,
                form: f.form,
                manufacturer: dp.isBrand && dp.productName
                  ? `${dp.labeler} (${dp.productName})`
                  : dp.labeler,
                packSize: dp.packageSize ? Math.round(dp.packageSize) : 0,
                packUnit: dp.packageUnit || 'EA',
                description: dp.packageDesc || `${displayStrength} (${dp.labeler})`,
                isGeneric: !dp.isBrand,
                abRating: 'AB',
              });
            }
          }
        }

        return products.sort((a, b) => {
          if (a.isGeneric !== b.isGeneric) return a.isGeneric ? -1 : 1;
          return a.manufacturer.localeCompare(b.manufacturer);
        });
      } catch (e) {
        console.error('getProductsForDrug failed:', e);
        return mockFallback?.getProductsForDrug(drugId, strength) || [];
      }
    },

    // ── Inventory batch lookup ──
    getInventoryBatch: async (ndcCodes) => {
      if (!ndcCodes?.length) return [];
      try {
        return await invoke('get_inventory_batch', { ndcCodes }) || [];
      } catch (e) {
        console.error('get_inventory_batch failed:', e);
        return [];
      }
    },

    // ── NDC lookup ──
    getProductByNdc: async (ndc) => {
      try {
        const result = await invoke('lookup_ndc', { ndc });
        if (!result) return mockFallback?.getProductByNdc(ndc) || null;
        return {
          id: `ndc-lookup`,
          drugId: null,
          ndc: result.ndc,
          strength: result.strength,
          form: result.form,
          manufacturer: result.brandName
            ? `${result.labeler} (${result.brandName})`
            : result.labeler,
          packSize: 0,
          packUnit: 'EA',
          description: `${result.drugName} ${result.strength} ${result.form} (${result.labeler})`,
          isGeneric: !result.brandName,
          abRating: 'AB',
        };
      } catch (e) {
        console.error('getProductByNdc failed:', e);
        return mockFallback?.getProductByNdc(ndc) || null;
      }
    },

    // ── Session management ─────────────────────────────────────────────

    startSession: async (userId, userRole) => {
      try {
        return await invoke('start_session', { userId, userRole });
      } catch (e) {
        console.error('start_session failed:', e);
        return null;
      }
    },

    endSession: async () => {
      try {
        await invoke('end_session');
      } catch (e) {
        console.error('end_session failed:', e);
      }
    },

    // ── Audit chain verification ───────────────────────────────────────

    verifyAuditChain: async (startSeq = null, endSeq = null) => {
      try {
        return await invoke('verify_audit_chain', { startSeq, endSeq });
      } catch (e) {
        console.error('verify_audit_chain failed:', e);
        return null;
      }
    },

    // ── Prescribers ────────────────────────────────────────────────────

    getAllPrescribers: async () => {
      try {
        return await invoke('get_all_prescribers') || [];
      } catch (e) {
        console.error('get_all_prescribers failed:', e);
        return mockFallback?.getAllPrescribers?.() || [];
      }
    },

    getPrescriber: async (id) => {
      try {
        return await invoke('get_prescriber', { id }) || null;
      } catch (e) {
        console.error('get_prescriber failed:', e);
        return mockFallback?.getPrescriber?.(id) || null;
      }
    },

    searchPrescribersDb: async (query) => {
      try {
        return await invoke('search_prescribers_db', { query }) || [];
      } catch (e) {
        console.error('search_prescribers_db failed:', e);
        return mockFallback?.searchPrescribers?.(query) || [];
      }
    },

    upsertPrescriber: async (prescriber) => {
      try {
        return await invoke('upsert_prescriber', { prescriber });
      } catch (e) {
        console.error('upsert_prescriber failed:', e);
        throw e;
      }
    },

    // ── Pass through to mock (frontend-only logic) ──
    getProduct: (...args) => mockFallback?.getProduct(...args) || null,
    // resolveEOrder: drug/prescriber matching stays frontend-side (needs DRUG_DATABASE)
    resolveEOrder: (...args) => mockFallback?.resolveEOrder(...args) || null,
    getRefillLimit: (...args) => mockFallback?.getRefillLimit(...args) || 99,
    getScheduleLabel: (...args) => mockFallback?.getScheduleLabel(...args) || '',

    // ── E-Orders ──────────────────────────────────────────────────────

    // Returns all pending eorders from DB, sorted oldest-first.
    // Each eorder has: id, messageId, receivedAt, patientId, status,
    //   rawFields (JSON string), transcribed (JSON string).
    getAllEOrders: async () => {
      try {
        const rows = await invoke('get_all_eorders') || [];
        return rows.map(eo => ({
          ...eo,
          raw: safeParseJson(eo.rawFields, {}),
          transcribed: safeParseJson(eo.transcribed, {}),
        }));
      } catch (e) {
        console.error('get_all_eorders failed:', e);
        return mockFallback?.getAllEOrders() || [];
      }
    },

    // Returns the pending eorder for a given patient (by patient_id).
    getEOrder: async (patientId) => {
      try {
        const eo = await invoke('get_eorder_by_patient', { patientId });
        if (!eo) {
          // Not in DB — may be an AI-generated script stored in RUNTIME_EORDERS
          return mockFallback?.getEOrder(patientId) || null;
        }
        return {
          ...eo,
          raw: safeParseJson(eo.rawFields, {}),
          transcribed: safeParseJson(eo.transcribed, {}),
        };
      } catch (e) {
        console.error('get_eorder_by_patient failed:', e);
        return mockFallback?.getEOrder(patientId) || null;
      }
    },

    // Mark an eorder resolved (clears it from the pending queue).
    // Call when tech opens an eorder for data entry.
    markEOrderResolved: async (eorderId) => {
      try {
        await invoke('mark_eorder_resolved', { id: eorderId });
      } catch (e) {
        console.error('mark_eorder_resolved failed:', e);
      }
    },

    // Ingest a raw NCPDP SCRIPT XML string into the eorders table.
    // Useful for manual testing or future SureScripts / file-drop wiring.
    ingestEOrderXml: async (xmlPayload, patientId = null) => {
      try {
        const eo = await invoke('ingest_eorder_xml', { xmlPayload, patientId });
        if (!eo) return null;
        return {
          ...eo,
          raw: safeParseJson(eo.rawFields, {}),
          transcribed: safeParseJson(eo.transcribed, {}),
        };
      } catch (e) {
        console.error('ingest_eorder_xml failed:', e);
        return null;
      }
    },

    // ── AI / E-Script Generator ────────────────────────────────────────

    // Call Haiku via Rust (avoids browser CORS). Returns raw JSON string.
    generateEScripts: async (apiKey) => {
      try {
        return await invoke('generate_escripts', { apiKey });
      } catch (e) {
        throw new Error(String(e));
      }
    },

    // ── Rx Engine ──────────────────────────────────────────────────────

    getUsers: async () => {
      try {
        return await invoke('get_users') || [];
      } catch (e) {
        console.error('get_users failed:', e);
        // Offline fallback — still lets the app function without Tauri
        return [
          { id: 'usr-tech-1', name: 'Alex Chen',      role: 'tech' },
          { id: 'usr-tech-2', name: 'Jordan Mills',    role: 'tech' },
          { id: 'usr-rph-1',  name: 'Dr. Sarah Park',  role: 'rph'  },
          { id: 'usr-rph-2',  name: 'Dr. Marcus Webb', role: 'rph'  },
        ];
      }
    },

    createPrescription: async (patientId, eorderData, actorId) => {
      try {
        return await invoke('create_prescription', {
          patientId,
          eorderData: typeof eorderData === 'string' ? eorderData : JSON.stringify(eorderData),
          actorId,
        });
      } catch (e) {
        console.error('create_prescription failed:', e);
        return null;
      }
    },

    transitionRx: async (rxId, action, actorId, actorRole, payload = {}) => {
      try {
        return await invoke('transition_rx', {
          rxId,
          action,
          actorId,
          actorRole,
          payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        });
      } catch (e) {
        console.error('transition_rx failed:', e);
        throw e; // Let caller handle — transition failures should be surfaced
      }
    },

    getPrescription: async (rxId) => {
      try {
        return await invoke('get_prescription', { rxId });
      } catch (e) {
        console.error('get_prescription failed:', e);
        return null;
      }
    },

    getPrescriptionsByPatient: async (patientId) => {
      try {
        return await invoke('get_prescriptions_by_patient', { patientId }) || [];
      } catch (e) {
        console.error('get_prescriptions_by_patient failed:', e);
        return [];
      }
    },

    getActivePrescriptions: async () => {
      try {
        return await invoke('get_active_prescriptions') || [];
      } catch (e) {
        console.error('get_active_prescriptions failed:', e);
        return [];
      }
    },

    getAllPrescriptions: async () => {
      try {
        return await invoke('get_all_prescriptions') || [];
      } catch (e) {
        console.error('get_all_prescriptions failed:', e);
        return [];
      }
    },

    getPrescriptionsByStatus: async (status) => {
      try {
        return await invoke('get_prescriptions_by_status', { status }) || [];
      } catch (e) {
        console.error('get_prescriptions_by_status failed:', e);
        return [];
      }
    },

    sellPrescription: async (rxId, actorId, actorRole) => {
      try {
        return await invoke('transition_rx', { rxId, action: 'SELL_RX', actorId, actorRole, payload: '{}' });
      } catch (e) {
        console.error('sell_prescription failed:', e);
        return null;
      }
    },

    getQueueCounts: async () => {
      try {
        return await invoke('get_queue_counts') || {};
      } catch (e) {
        console.error('get_queue_counts failed:', e);
        return {};
      }
    },

    getEventsByRx: async (rxId) => {
      try {
        return await invoke('get_events_by_rx', { rxId }) || [];
      } catch (e) {
        console.error('get_events_by_rx failed:', e);
        return [];
      }
    },

    getEventsByDateRange: async (start, end) => {
      try {
        return await invoke('get_events_by_date_range', { start, end }) || [];
      } catch (e) {
        console.error('get_events_by_date_range failed:', e);
        return [];
      }
    },

    // ── Patients ──────────────────────────────────────────────────────

    getPatient: async (id) => {
      try {
        return await invoke('get_patient', { id }) || null;
      } catch (e) {
        console.error('get_patient failed:', e);
        return null;
      }
    },

    upsertPatient: async (patient) => {
      try {
        return await invoke('upsert_patient', { patient }) || null;
      } catch (e) {
        console.error('upsert_patient failed:', e);
        return null;
      }
    },

    getAllPatients: async () => {
      try {
        return await invoke('get_all_patients') || [];
      } catch (e) {
        console.error('get_all_patients failed:', e);
        return [];
      }
    },

    searchPatients: async (query) => {
      try {
        return await invoke('search_patients', { query }) || [];
      } catch (e) {
        console.error('search_patients failed:', e);
        return [];
      }
    },

    // ── Fill History ──────────────────────────────────────────────────

    getFillHistory: async (patientId) => {
      try {
        return await invoke('get_fill_history', { patientId }) || [];
      } catch (e) {
        console.error('get_fill_history failed:', e);
        return mockFallback?.getFillHistory?.(patientId) || [];
      }
    },

    appendFillHistory: async (entry) => {
      try {
        return await invoke('append_fill_history', { entry });
      } catch (e) {
        console.error('append_fill_history failed:', e);
        return null;
      }
    },
  };
}
