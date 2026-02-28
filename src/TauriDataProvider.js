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

// ─── Provider ─────────────────────────────────────────────────────────

export function createTauriDataProvider(mockFallback) {

  return {
    // ── Drug search — LIGHTWEIGHT, no manufacturer/NDC loading ──
    searchDrugs: async (query) => {
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

        // Group by drug_id, collect all strength+form combos
        const drugMap = new Map();
        for (const hit of hits) {
          if (!drugMap.has(hit.drugId)) {
            drugMap.set(hit.drugId, {
              id: `db-${hit.drugId}`,
              _backendId: hit.drugId,
              name: hit.drugName,
              brandNames: [],
              strengths: [],
              _forms: new Set(),
              form: '',  // set after collecting all forms
              route: hit.route || 'oral',
              schedule: hit.deaSchedule || 'Rx',
              drugClass: hit.drugClass || '',
              maxDaily: null,
              commonDoses: [],
              ndcByStrength: {},
              _score: 0,
              _matchedStrength: null,
            });
          }

          const entry = drugMap.get(hit.drugId);
          const displayStrength = formatStrengthWithForm(hit.strength, hit.form);

          if (!entry.strengths.includes(displayStrength)) {
            entry.strengths.push(displayStrength);
          }
          entry._forms.add(hit.form);

          if (strengthQ && displayStrength.toLowerCase().includes(strengthQ.toLowerCase())) {
            entry._matchedStrength = displayStrength;
            entry._score = -5;
          }
        }

        // Build final results
        const nameQLower = nameQ.toLowerCase();
        return Array.from(drugMap.values())
          .map(d => {
            // Join all forms: "tablet, capsule" or just "tablet"
            d.form = Array.from(d._forms).join(', ');
            delete d._forms;

            let score = d._score || 0;
            const name = d.name.toLowerCase();
            if (name === nameQLower) score -= 100;
            else if (name.startsWith(nameQLower)) score -= 50;
            else if (name.includes(nameQLower)) score -= 20;
            d._score = score;
            return d;
          })
          .sort((a, b) => a._score - b._score || a.name.localeCompare(b.name))
          .slice(0, 12);
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

    // ── Pass through to mock ──
    searchPrescribers: (...args) => mockFallback?.searchPrescribers(...args) || [],
    getPrescriber: (...args) => mockFallback?.getPrescriber(...args) || null,
    getProduct: (...args) => mockFallback?.getProduct(...args) || null,
    getEOrder: (...args) => mockFallback?.getEOrder(...args) || null,
    getAllEOrders: (...args) => mockFallback?.getAllEOrders(...args) || [],
    resolveEOrder: (...args) => mockFallback?.resolveEOrder(...args) || null,
    submitRx: (...args) => mockFallback?.submitRx(...args) || {},
    getRefillLimit: (...args) => mockFallback?.getRefillLimit(...args) || 99,
    getScheduleLabel: (...args) => mockFallback?.getScheduleLabel(...args) || '',
  };
}
