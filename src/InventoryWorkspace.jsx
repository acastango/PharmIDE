import { useState, useEffect, useRef, useCallback } from "react";

const isTauri = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
let _invoke;
async function getInvoke() {
  if (_invoke) return _invoke;
  if (isTauri()) { const t = await import('@tauri-apps/api/core'); _invoke = t.invoke; }
  else { _invoke = async (cmd, args) => { console.warn('[mock]', cmd, args); return null; }; }
  return _invoke;
}
async function invoke(cmd, args) { return (await getInvoke())(cmd, args); }

function formatStrengthWithForm(rawStrength, form) {
  if (!rawStrength) return '';
  const s = rawStrength.trim(), f = (form || '').toLowerCase();
  if (/[a-zA-Z]/.test(s)) {
    const sL = s.toLowerCase();
    if (sL.includes('tablet') || sL.includes('capsule') || sL.includes('solution') || sL.includes('ml')) return s;
    return `${s} ${form}`;
  }
  const m = s.match(/^([\d.]+)\/([\d.]+)$/);
  if (m) {
    const [, num, denom] = m;
    if ((f.includes('solution') || f.includes('suspension') || f.includes('syrup') || f.includes('elixir') || f.includes('liquid')) && parseFloat(denom) > 1)
      return `${num}mg/${denom}ml ${form}`;
    if (denom === '1') return `${num}mg ${form}`;
    return `${num}/${denom}mg ${form}`;
  }
  if (/^[\d.]+$/.test(s)) return `${s}mg ${form}`;
  return `${s} ${form}`;
}

export default function InventoryWorkspace({ color }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef(null);
  const [expandedNdc, setExpandedNdc] = useState(null);
  const [editFields, setEditFields] = useState({});
  const [saving, setSaving] = useState(false);
  const [quickEditNdc, setQuickEditNdc] = useState(null);
  const [quickEditValue, setQuickEditValue] = useState('');
  const quickInputRef = useRef(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 35;

  const C = color || { bg: "#0891b2", text: "#164e63", border: "#67e8f9", light: "#ecfeff" };

  // ─── Search ─────────────────────────────────────────────────────

  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (searchQuery.length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const parts = searchQuery.split(",").map(p => p.trim()).filter(Boolean);
        const nameQ = parts[0] || null;
        const doseQ = parts[1] || null;
        const formQ = parts[2] || null;
        if (!nameQ || nameQ.length < 2) { setResults([]); return; }

        const hits = await invoke('search_drugs_fast', { drugName: nameQ, dose: doseQ, form: formQ, limit: 20 });
        if (!hits || hits.length === 0) { setResults([]); return; }

        const drugIds = [...new Set(hits.map(h => h.drugId))].slice(0, 5);
        const drugNames = {};
        for (const h of hits) drugNames[h.drugId] = h.drugName;

        const allProducts = [];
        for (const drugId of drugIds) {
          const prods = await invoke('get_drug_dispensable_products', { drugId });
          if (prods) for (const p of prods) { p._drugName = drugNames[drugId] || ''; allProducts.push(p); }
        }

        let filtered = allProducts;
        if (doseQ) { const dL = doseQ.toLowerCase(); filtered = filtered.filter(p => p.strength.toLowerCase().includes(dL)); }
        if (formQ) { const fL = formQ.toLowerCase(); filtered = filtered.filter(p => p.form.toLowerCase().includes(fL)); }

        const ndcCodes = filtered.map(p => p.ndc);
        let inventoryMap = {};
        if (ndcCodes.length > 0) {
          try {
            const records = await invoke('get_inventory_batch', { ndcCodes });
            if (records) for (const r of records) inventoryMap[r.ndcCode] = r;
          } catch (e) {}
        }

        setResults(filtered.map(p => ({
          ...p, displayStrength: formatStrengthWithForm(p.strength, p.form),
          inventory: inventoryMap[p.ndc] || null,
        })));
        setPage(0);
      } catch (e) { console.error(e); setResults([]); }
      finally { setSearching(false); }
    }, 200);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery]);

  // ─── Expand/collapse file card ──────────────────────────────────

  const toggleExpand = (ndc, product) => {
    if (expandedNdc === ndc) { setExpandedNdc(null); return; }
    setExpandedNdc(ndc);
    const inv = product.inventory || {};
    setEditFields({
      onHand: inv.onHand != null ? String(inv.onHand) : '',
      shelfLocation: inv.shelfLocation || '',
      lotNumber: inv.lotNumber || '',
      expiration: inv.expiration || '',
      reorderPoint: inv.reorderPoint != null ? String(inv.reorderPoint) : '',
      notes: inv.notes || '',
    });
  };

  // ─── Save file card ─────────────────────────────────────────────

  const saveFile = async (ndc) => {
    setSaving(true);
    try {
      await invoke('update_inventory', { update: {
        ndcCode: ndc,
        onHand: editFields.onHand !== '' ? parseInt(editFields.onHand, 10) : null,
        reorderPoint: editFields.reorderPoint !== '' ? parseInt(editFields.reorderPoint, 10) : null,
        shelfLocation: editFields.shelfLocation || null,
        lotNumber: editFields.lotNumber || null,
        expiration: editFields.expiration || null,
        notes: editFields.notes || null,
      }});
      setResults(prev => prev.map(p => p.ndc !== ndc ? p : { ...p, inventory: {
        ndcCode: ndc, onHand: editFields.onHand !== '' ? parseInt(editFields.onHand, 10) : null,
        reorderPoint: editFields.reorderPoint !== '' ? parseInt(editFields.reorderPoint, 10) : null,
        shelfLocation: editFields.shelfLocation || null, lotNumber: editFields.lotNumber || null,
        expiration: editFields.expiration || null, notes: editFields.notes || null,
        updatedAt: new Date().toISOString(),
      }}));
      setExpandedNdc(null);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  // ─── Quick on-hand edit ─────────────────────────────────────────

  const startQuickEdit = (e, ndc, val) => {
    e.stopPropagation();
    setQuickEditNdc(ndc); setQuickEditValue(String(val ?? ''));
    setTimeout(() => quickInputRef.current?.select(), 30);
  };
  const saveQuickEdit = async () => {
    if (!quickEditNdc) return;
    const val = parseInt(quickEditValue, 10);
    if (isNaN(val) || val < 0) { setQuickEditNdc(null); return; }
    try {
      await invoke('update_inventory', { update: { ndcCode: quickEditNdc, onHand: val, reorderPoint: null, shelfLocation: null, lotNumber: null, expiration: null, notes: null }});
      setResults(prev => prev.map(p => p.ndc !== quickEditNdc ? p : { ...p, inventory: { ...(p.inventory || {}), ndcCode: quickEditNdc, onHand: val, updatedAt: new Date().toISOString() }}));
    } catch (e) { console.error(e); }
    setQuickEditNdc(null);
  };

  // ─── Render ─────────────────────────────────────────────────────

  const fld = { width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #2e3340", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", outline: "none", boxSizing: "border-box" };
  const lbl = { display: "block", fontSize: 9, fontWeight: 700, color: "#5a6475", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3, fontFamily: "'IBM Plex Mono', monospace" };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", fontFamily: "'IBM Plex Sans', sans-serif", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #2a2e38", background: '#1a1d24' }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 700, color: C.bg }}>INVENTORY</span>
          <span style={{ fontSize: 10, color: "#5a6475" }}>name,dose,form</span>
        </div>
        <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          placeholder="met,25,tab  ·  gaba,300  ·  amox" autoFocus
          style={{ ...fld, fontSize: 14, padding: "9px 14px", border: `1.5px solid ${C.bg}40` }}
          onFocus={e => e.target.style.borderColor = C.bg} onBlur={e => e.target.style.borderColor = C.bg + '40'} />
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {searching && <div style={{ padding: 16, color: "#5a6475", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", textAlign: "center" }}>Searching...</div>}
        {!searching && searchQuery.length >= 2 && results.length === 0 && <div style={{ padding: 24, color: "#5a6475", fontSize: 12, textAlign: "center" }}>No products found.</div>}

        {(() => {
          const totalPages = Math.ceil(results.length / PAGE_SIZE);
          const pageResults = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
          return pageResults.map(p => {
          const isExp = expandedNdc === p.ndc;
          const onHand = p.inventory?.onHand;
          const isQE = quickEditNdc === p.ndc;
          const reorder = p.inventory?.reorderPoint;
          const isLow = onHand != null && reorder != null && onHand <= reorder;
          const shelf = p.inventory?.shelfLocation;

          return (
            <div key={p.ndcId} style={{ borderBottom: "1px solid #2a2e38" }}>
              <div onClick={() => toggleExpand(p.ndc, p)} style={{
                display: "grid", gridTemplateColumns: "150px 1fr 80px 60px",
                padding: "8px 16px", cursor: "pointer", alignItems: "center", fontSize: 12,
                background: isExp ? C.light : "transparent",
                borderLeft: isExp ? `3px solid ${C.bg}` : "3px solid transparent",
                transition: "background 0.1s",
              }}
                onMouseOver={e => { if (!isExp) e.currentTarget.style.background = '#262a35'; }}
                onMouseOut={e => { if (!isExp) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 800, color: "#e2e8f0", letterSpacing: "0.3px", fontSize: 11 }}>{p.ndc}</span>
                <div style={{ minWidth: 0, overflow: "hidden" }}>
                  <div style={{ fontWeight: 600, color: "#e2e8f0", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p._drugName} {p.displayStrength}
                  </div>
                  <div style={{ fontSize: 11, color: "#5a6475", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{p.isBrand && p.productName ? `${p.labeler} (${p.productName})` : p.labeler}</span>
                    {p.isBrand && <span style={{ fontSize: 8, fontWeight: 700, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe", padding: "0 3px", borderRadius: 2 }}>BRAND</span>}
                    {shelf && <span style={{ fontSize: 9, color: "#0891b2", background: "#ecfeff", padding: "0 4px", borderRadius: 2, border: "1px solid #cffafe" }}>{shelf}</span>}
                  </div>
                </div>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#5a6475", textAlign: "right" }}>
                  {p.packageSize ? `${Math.round(p.packageSize)} ${p.packageUnit || 'EA'}` : (p.packageDesc || '')}
                </span>
                <div style={{ textAlign: "right" }} onClick={e => e.stopPropagation()}>
                  {isQE ? (
                    <input ref={quickInputRef} type="number" min="0" value={quickEditValue}
                      onChange={e => setQuickEditValue(e.target.value)} onBlur={saveQuickEdit}
                      onKeyDown={e => { if (e.key === 'Enter') saveQuickEdit(); if (e.key === 'Escape') setQuickEditNdc(null); }}
                      autoFocus style={{ width: 50, padding: "2px 4px", borderRadius: 3, border: `2px solid ${C.bg}`, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, textAlign: "right", outline: "none" }} />
                  ) : (
                    <span onClick={e => startQuickEdit(e, p.ndc, onHand)} style={{
                      display: "inline-block", padding: "2px 6px", borderRadius: 3,
                      fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 12,
                      cursor: "pointer", minWidth: 32, textAlign: "right",
                      color: onHand == null ? "#cbd5e1" : isLow ? "#dc2626" : "#059669",
                      background: onHand == null ? "transparent" : isLow ? "#fef2f2" : "#f0fdf4",
                      border: `1px solid ${onHand == null ? '#e2e8f0' : isLow ? '#fecaca' : '#bbf7d0'}`,
                    }}>{onHand != null ? onHand : '—'}</span>
                  )}
                </div>
              </div>

              {/* Expanded file card */}
              {isExp && (
                <div style={{ padding: "12px 16px 16px 19px", background: "#21242d", borderLeft: `3px solid ${C.bg}`, borderTop: `1px solid ${C.bg}20` }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <div><label style={lbl}>On Hand</label><input type="number" min="0" value={editFields.onHand} onChange={e => setEditFields(f => ({ ...f, onHand: e.target.value }))} style={fld} onFocus={e => e.target.style.borderColor = C.bg} onBlur={e => e.target.style.borderColor = '#cbd5e1'} /></div>
                    <div><label style={lbl}>Reorder Point</label><input type="number" min="0" value={editFields.reorderPoint} onChange={e => setEditFields(f => ({ ...f, reorderPoint: e.target.value }))} style={fld} onFocus={e => e.target.style.borderColor = C.bg} onBlur={e => e.target.style.borderColor = '#cbd5e1'} /></div>
                    <div><label style={lbl}>Shelf Location</label><input type="text" value={editFields.shelfLocation} onChange={e => setEditFields(f => ({ ...f, shelfLocation: e.target.value }))} placeholder="A3-B2" style={fld} onFocus={e => e.target.style.borderColor = C.bg} onBlur={e => e.target.style.borderColor = '#cbd5e1'} /></div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <div><label style={lbl}>Lot Number</label><input type="text" value={editFields.lotNumber} onChange={e => setEditFields(f => ({ ...f, lotNumber: e.target.value }))} style={fld} onFocus={e => e.target.style.borderColor = C.bg} onBlur={e => e.target.style.borderColor = '#cbd5e1'} /></div>
                    <div><label style={lbl}>Expiration</label><input type="text" value={editFields.expiration} onChange={e => setEditFields(f => ({ ...f, expiration: e.target.value }))} placeholder="MM/YY" style={fld} onFocus={e => e.target.style.borderColor = C.bg} onBlur={e => e.target.style.borderColor = '#cbd5e1'} /></div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={lbl}>Notes</label>
                    <textarea value={editFields.notes} onChange={e => setEditFields(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...fld, resize: "vertical" }}
                      onFocus={e => e.target.style.borderColor = C.bg} onBlur={e => e.target.style.borderColor = '#cbd5e1'} />
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setExpandedNdc(null)} style={{ padding: "5px 14px", borderRadius: 4, border: "1px solid #cbd5e1", background: "#21242d", color: "#5a6475", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace" }}>Cancel</button>
                    <button onClick={() => saveFile(p.ndc)} disabled={saving} style={{ padding: "5px 14px", borderRadius: 4, border: "none", background: C.bg, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving...' : 'Save'}</button>
                  </div>
                </div>
              )}
            </div>
          );
        });
        })()}
      </div>

      {results.length > 0 && (() => {
        const totalPages = Math.ceil(results.length / PAGE_SIZE);
        return (
          <div style={{ padding: "6px 16px", borderTop: "1px solid #e2e8f0", fontSize: 10, color: "#5a6475", fontFamily: "'IBM Plex Mono', monospace", background: "#1a1d24", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{results.length} product{results.length !== 1 ? 's' : ''}</span>
            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  style={{ padding: "2px 8px", border: "1px solid #cbd5e1", borderRadius: 3, background: page === 0 ? "#f8fafc" : "#fff", color: page === 0 ? "#cbd5e1" : "#475569", cursor: page === 0 ? "default" : "pointer", fontSize: 10, fontFamily: "'IBM Plex Mono', monospace" }}>‹</button>
                <span style={{ fontSize: 10 }}>{page + 1} / {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  style={{ padding: "2px 8px", border: "1px solid #cbd5e1", borderRadius: 3, background: page >= totalPages - 1 ? "#f8fafc" : "#fff", color: page >= totalPages - 1 ? "#cbd5e1" : "#475569", cursor: page >= totalPages - 1 ? "default" : "pointer", fontSize: 10, fontFamily: "'IBM Plex Mono', monospace" }}>›</button>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
