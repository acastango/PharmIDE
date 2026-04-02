import React, { useState, useEffect, useRef, useCallback } from 'react';

const isTauri = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
let _invoke;
async function getInvoke() {
  if (_invoke) return _invoke;
  if (isTauri()) {
    const t = await import('@tauri-apps/api/core');
    _invoke = t.invoke;
  } else {
    _invoke = async (cmd, args) => { console.warn('[mock]', cmd, args); return mockHandler(cmd, args); };
  }
  return _invoke;
}
async function invoke(cmd, args) { return (await getInvoke())(cmd, args); }

// ─── Styles ───────────────────────────────────────────────────────────

const C = {
  bg: '#0d1117', surface: '#161b22', surfaceHover: '#1c2333',
  surfaceActive: '#21283b', border: '#30363d', borderFocus: '#4a5568',
  text: '#e6edf3', textMuted: '#8b949e', textDim: '#484f58',
  accent: '#8b949e', accentDim: '#1c2333',
  green: '#8b949e', yellow: '#8b949e', red: '#f85149',
  purple: '#8b949e', orange: '#8b949e',
};
const F = {
  sans: "'IBM Plex Sans', -apple-system, sans-serif",
  mono: "'IBM Plex Mono', 'Consolas', monospace",
};

// ─── Component ────────────────────────────────────────────────────────

export default function DrugBrowser() {
  // Quick bar (single input, comma-separated)
  const [quickBar, setQuickBar] = useState('');
  const [useQuickBar, setUseQuickBar] = useState(true);

  // Three-field search state
  const [drugQuery, setDrugQuery] = useState('');
  const [doseQuery, setDoseQuery] = useState('');
  const [formQuery, setFormQuery] = useState('');

  // Cascade suggestions (appear when you click into a field after selecting prior)
  const [drugSuggestions, setDrugSuggestions] = useState([]);
  const [selectedDrug, setSelectedDrug] = useState(null);
  const [doseOptions, setDoseOptions] = useState([]);
  const [selectedDose, setSelectedDose] = useState(null);
  const [formOptions, setFormOptions] = useState([]);
  const [showDrugDropdown, setShowDrugDropdown] = useState(false);
  const [showDoseDropdown, setShowDoseDropdown] = useState(false);
  const [showFormDropdown, setShowFormDropdown] = useState(false);

  // Results
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [expandedProduct, setExpandedProduct] = useState(null);

  // NDC lookup
  const [ndcQuery, setNdcQuery] = useState('');
  const [ndcResult, setNdcResult] = useState(undefined);
  const [viewMode, setViewMode] = useState('search');

  const searchTimer = useRef(null);
  const quickBarRef = useRef(null);
  const drugInputRef = useRef(null);

  // ─── Quick bar: parse comma-separated into three fields ──────────

  useEffect(() => {
    if (!useQuickBar) return;
    const parts = quickBar.split(',').map(s => s.trim());
    setDrugQuery(parts[0] || '');
    setDoseQuery(parts[1] || '');
    setFormQuery(parts[2] || '');
    // Clear cascade selections when typing
    setSelectedDrug(null);
    setSelectedDose(null);
  }, [quickBar, useQuickBar]);

  // ─── Drug name suggestions (for cascade mode) ───────────────────

  useEffect(() => {
    if (drugQuery.length < 2) { setDrugSuggestions([]); return; }
    const t = setTimeout(async () => {
      try {
        const s = await invoke('get_drug_names', { query: drugQuery, limit: 12 });
        setDrugSuggestions(s);
      } catch (e) { console.error(e); }
    }, 120);
    return () => clearTimeout(t);
  }, [drugQuery]);

  // ─── Cascade: load dose options when drug selected ──────────────

  useEffect(() => {
    if (!selectedDrug) { setDoseOptions([]); return; }
    (async () => {
      try {
        const d = await invoke('get_dose_options', { drugId: selectedDrug.drugId });
        setDoseOptions(d);
      } catch (e) { console.error(e); }
    })();
  }, [selectedDrug]);

  // ─── Cascade: load form options when dose selected ──────────────

  useEffect(() => {
    if (!selectedDose) { setFormOptions([]); return; }
    (async () => {
      try {
        const f = await invoke('get_form_options', { strengthId: selectedDose.strengthId });
        setFormOptions(f);
      } catch (e) { console.error(e); }
    })();
  }, [selectedDose]);

  // ─── Search clinical products (fires on any field change) ───────

  const doSearch = useCallback(async () => {
    const hasInput = drugQuery.length >= 2 || doseQuery.length >= 1 || formQuery.length >= 1;
    if (!hasInput) { setResults([]); return; }
    setSearching(true);
    try {
      const r = await invoke('search_clinical_products', {
        drugName: drugQuery || null,
        dose: doseQuery || null,
        form: formQuery || null,
        limit: 50,
      });
      setResults(r);
    } catch (e) {
      console.error('Search failed:', e);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [drugQuery, doseQuery, formQuery]);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(doSearch, 180);
    return () => clearTimeout(searchTimer.current);
  }, [doSearch]);

  // ─── Cascade pick handlers ──────────────────────────────────────

  const pickDrug = (drug) => {
    setSelectedDrug(drug);
    setDrugQuery(drug.name);
    setShowDrugDropdown(false);
    if (useQuickBar) {
      const parts = quickBar.split(',');
      parts[0] = drug.name;
      setQuickBar(parts.join(','));
    }
  };

  const pickDose = (dose) => {
    setSelectedDose(dose);
    setDoseQuery(dose.strength);
    setShowDoseDropdown(false);
    if (useQuickBar) {
      const parts = quickBar.split(',');
      parts[1] = dose.strength;
      setQuickBar(parts.join(','));
    }
  };

  const pickForm = (form) => {
    setFormQuery(form.form);
    setShowFormDropdown(false);
    if (useQuickBar) {
      const parts = quickBar.split(',');
      parts[2] = form.form;
      setQuickBar(parts.join(','));
    }
  };

  const clearAll = () => {
    setQuickBar(''); setDrugQuery(''); setDoseQuery(''); setFormQuery('');
    setSelectedDrug(null); setSelectedDose(null);
    setDrugSuggestions([]); setDoseOptions([]); setFormOptions([]);
    setResults([]); setExpandedProduct(null);
    if (useQuickBar) quickBarRef.current?.focus();
    else drugInputRef.current?.focus();
  };

  // ─── NDC Lookup ─────────────────────────────────────────────────

  const doNdcLookup = async () => {
    if (!ndcQuery) return;
    try {
      const r = await invoke('lookup_ndc', { ndc: ndcQuery });
      setNdcResult(r);
    } catch (e) { console.error(e); setNdcResult(null); }
  };

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div style={{ width: '100%', height: '100%', background: C.bg, color: C.text, fontFamily: F.sans, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '12px 24px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
        <span style={{ fontFamily: F.mono, fontSize: '14px', fontWeight: 700, color: C.accent, letterSpacing: '0.5px' }}>DRUG INDEX</span>
        <div style={{ display: 'flex', gap: '2px', marginLeft: '24px' }}>
          {[{ key: 'search', label: 'Product Search' }, { key: 'ndc', label: 'NDC Lookup' }].map(tab => (
            <button key={tab.key} onClick={() => setViewMode(tab.key)} style={{
              padding: '6px 14px', border: 'none', cursor: 'pointer',
              fontFamily: F.mono, fontSize: '11px', fontWeight: 500,
              background: viewMode === tab.key ? C.accentDim : 'transparent',
              color: viewMode === tab.key ? C.accent : C.textMuted, borderRadius: '4px',
            }}>{tab.label}</button>
          ))}
        </div>

        {/* Mode toggle */}
        {viewMode === 'search' && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }}>
            <button onClick={() => setUseQuickBar(true)} style={{
              padding: '4px 10px', border: 'none', cursor: 'pointer',
              fontFamily: F.mono, fontSize: '10px',
              background: useQuickBar ? C.accentDim : 'transparent',
              color: useQuickBar ? C.accent : C.textDim, borderRadius: '3px',
            }}>QUICK</button>
            <button onClick={() => setUseQuickBar(false)} style={{
              padding: '4px 10px', border: 'none', cursor: 'pointer',
              fontFamily: F.mono, fontSize: '10px',
              background: !useQuickBar ? C.accentDim : 'transparent',
              color: !useQuickBar ? C.accent : C.textDim, borderRadius: '3px',
            }}>FIELDS</button>
          </div>
        )}
      </div>

      {/* ─── PRODUCT SEARCH ─── */}
      {viewMode === 'search' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Search bar area */}
          <div style={{ padding: '16px 24px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>

            {/* QUICK MODE: single bar */}
            {useQuickBar && (
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input ref={quickBarRef} type="text" value={quickBar}
                    onChange={e => setQuickBar(e.target.value)}
                    placeholder="drug, dose, form — e.g. met,500,tab"
                    style={{
                      width: '100%', padding: '10px 14px', background: C.surface,
                      border: `1px solid ${C.border}`, borderRadius: '6px', color: C.text,
                      fontFamily: F.mono, fontSize: '15px', outline: 'none', boxSizing: 'border-box',
                      letterSpacing: '0.3px',
                    }}
                    onFocus={e => e.target.style.borderColor = C.borderFocus}
                    onBlur={e => e.target.style.borderColor = C.border}
                    autoFocus />

                  {/* Live parse indicator */}
                  <div style={{ display: 'flex', gap: '16px', marginTop: '6px', fontFamily: F.mono, fontSize: '10px' }}>
                    <span style={{ color: drugQuery ? C.accent : C.textDim }}>
                      DRUG: {drugQuery || '—'}
                    </span>
                    <span style={{ color: doseQuery ? C.yellow : C.textDim }}>
                      DOSE: {doseQuery || '—'}
                    </span>
                    <span style={{ color: formQuery ? C.green : C.textDim }}>
                      FORM: {formQuery || '—'}
                    </span>
                  </div>
                </div>
                <button onClick={clearAll} style={clearBtnStyle()}>CLEAR</button>
              </div>
            )}

            {/* FIELDS MODE: three separate inputs */}
            {!useQuickBar && (
              <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                {/* Drug Name */}
                <div style={{ flex: 3, position: 'relative' }}>
                  <label style={labelStyle()}>DRUG NAME</label>
                  <input ref={drugInputRef} type="text" value={drugQuery}
                    onChange={e => { setDrugQuery(e.target.value); setSelectedDrug(null); }}
                    onFocus={() => setShowDrugDropdown(true)}
                    onBlur={() => setTimeout(() => setShowDrugDropdown(false), 200)}
                    placeholder="metformin, lisinopril..."
                    style={inputStyle()} autoFocus />
                  {showDrugDropdown && drugSuggestions.length > 0 && !selectedDrug && (
                    <div style={dropdownStyle()}>
                      {drugSuggestions.map(d => (
                        <div key={d.drugId} onMouseDown={() => pickDrug(d)} style={dropdownItemStyle()}>
                          <span style={{ fontSize: '13px' }}>{d.name}</span>
                          {d.drugClass && <span style={{ fontFamily: F.mono, fontSize: '10px', color: C.textDim, marginLeft: '8px' }}>{d.drugClass}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Dose */}
                <div style={{ flex: 1.5, position: 'relative' }}>
                  <label style={labelStyle()}>DOSE</label>
                  <input type="text" value={doseQuery}
                    onChange={e => { setDoseQuery(e.target.value); setSelectedDose(null); }}
                    onFocus={() => setShowDoseDropdown(true)}
                    onBlur={() => setTimeout(() => setShowDoseDropdown(false), 200)}
                    placeholder="500, 10mg..."
                    style={inputStyle()} />
                  {showDoseDropdown && doseOptions.length > 0 && !selectedDose && selectedDrug && (
                    <div style={dropdownStyle()}>
                      {doseOptions.map(d => (
                        <div key={d.strengthId} onMouseDown={() => pickDose(d)} style={dropdownItemStyle()}>
                          {d.strength}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Form */}
                <div style={{ flex: 1.5, position: 'relative' }}>
                  <label style={labelStyle()}>FORM</label>
                  <input type="text" value={formQuery}
                    onChange={e => setFormQuery(e.target.value)}
                    onFocus={() => setShowFormDropdown(true)}
                    onBlur={() => setTimeout(() => setShowFormDropdown(false), 200)}
                    placeholder="tab, cap, sol..."
                    style={inputStyle()} />
                  {showFormDropdown && formOptions.length > 0 && selectedDose && (
                    <div style={dropdownStyle()}>
                      {formOptions.map(f => (
                        <div key={f.formId} onMouseDown={() => pickForm(f)} style={dropdownItemStyle()}>
                          {f.form} {f.route && <span style={{ color: C.textDim }}>({f.route})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ paddingTop: '18px' }}>
                  <button onClick={clearAll} style={clearBtnStyle()}>CLEAR</button>
                </div>
              </div>
            )}
          </div>

          {/* Results */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 24px' }}>
            {searching && <div style={{ fontFamily: F.mono, fontSize: '12px', color: C.textMuted, padding: '12px 0' }}>Searching...</div>}

            {!searching && results.length === 0 && drugQuery.length >= 2 && (
              <div style={{ fontFamily: F.mono, fontSize: '12px', color: C.textDim, padding: '24px 0', textAlign: 'center' }}>No clinical products found</div>
            )}

            {/* Result count */}
            {results.length > 0 && (
              <div style={{ fontFamily: F.mono, fontSize: '11px', color: C.textDim, padding: '8px 0 4px' }}>
                {results.length} product{results.length !== 1 ? 's' : ''}
              </div>
            )}

            {results.map(cp => (
              <div key={cp.clinicalId} style={{
                marginBottom: '4px', background: C.surface, borderRadius: '6px',
                border: `1px solid ${expandedProduct === cp.clinicalId ? C.borderFocus + '44' : C.border}`,
                overflow: 'hidden', transition: 'border-color 0.15s',
              }}>
                {/* Product row */}
                <div onClick={() => setExpandedProduct(expandedProduct === cp.clinicalId ? null : cp.clinicalId)}
                  style={{ padding: '10px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px' }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

                  <span style={{ fontSize: '14px', fontWeight: 600, flex: 2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cp.drugName}</span>
                  <span style={{ fontFamily: F.mono, fontSize: '13px', color: C.accent, width: '120px', flexShrink: 0 }}>{cp.strength}</span>
                  <span style={{ fontFamily: F.mono, fontSize: '12px', color: C.yellow, width: '100px', flexShrink: 0 }}>{cp.form}</span>
                  <span style={{ fontFamily: F.mono, fontSize: '11px', color: C.textDim, width: '50px', flexShrink: 0 }}>{cp.route || ''}</span>

                  {cp.deaSchedule && (
                    <span style={{ fontFamily: F.mono, fontSize: '10px', color: C.red, background: '#2e1a1a', padding: '1px 6px', borderRadius: '3px' }}>{cp.deaSchedule}</span>
                  )}

                  <span style={{ fontFamily: F.mono, fontSize: '11px', color: C.textDim, width: '50px', textAlign: 'right', flexShrink: 0 }}>
                    {cp.manufacturers.length} mfr{cp.manufacturers.length !== 1 ? 's' : ''}
                  </span>
                  <span style={{ color: C.textDim, fontSize: '11px', width: '14px', textAlign: 'center', flexShrink: 0 }}>
                    {expandedProduct === cp.clinicalId ? '▾' : '▸'}
                  </span>
                </div>

                {/* Expanded manufacturers + NDCs */}
                {expandedProduct === cp.clinicalId && cp.manufacturers.length > 0 && (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 16px 12px' }}>
                    {cp.manufacturers.map(mfr => (
                      <div key={mfr.productId} style={{ marginBottom: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 500 }}>{mfr.labeler}</span>
                          {mfr.productName && <span style={{ fontFamily: F.mono, fontSize: '11px', color: C.textMuted }}>{mfr.productName}</span>}
                          {mfr.isBrand && <span style={{ fontFamily: F.mono, fontSize: '10px', color: C.purple, background: '#1f1a2e', padding: '1px 6px', borderRadius: '3px' }}>BRAND</span>}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginLeft: '12px' }}>
                          {mfr.ndcs.map(ndc => (
                            <span key={ndc.ndcId} style={{
                              fontFamily: F.mono, fontSize: '11px', color: C.textMuted,
                              background: C.surfaceHover, padding: '3px 8px', borderRadius: '4px',
                              border: `1px solid ${C.border}`,
                            }}>
                              {ndc.ndcCode}
                              {ndc.packageDesc && <span style={{ color: C.textDim, marginLeft: '6px' }}>{ndc.packageDesc}</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── NDC LOOKUP ─── */}
      {viewMode === 'ndc' && (
        <div style={{ flex: 1, padding: '24px', maxWidth: '600px' }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
            <input type="text" value={ndcQuery}
              onChange={e => setNdcQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doNdcLookup()}
              placeholder="Scan or enter NDC..."
              style={{ flex: 1, padding: '12px 14px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', color: C.text, fontFamily: F.mono, fontSize: '16px', outline: 'none', letterSpacing: '1px' }}
              autoFocus />
            <button onClick={doNdcLookup} style={{
              padding: '12px 20px', background: C.accent, border: 'none', borderRadius: '6px',
              color: '#000', fontFamily: F.mono, fontSize: '13px', fontWeight: 600, cursor: 'pointer',
            }}>LOOKUP</button>
          </div>

          {ndcResult === null && (
            <div style={{ padding: '16px', background: '#2e1a1a', borderRadius: '8px', border: `1px solid ${C.red}33`, fontFamily: F.mono, fontSize: '13px', color: C.red }}>NDC not found</div>
          )}

          {ndcResult && ndcResult !== undefined && (
            <div style={{ background: C.surface, borderRadius: '8px', border: `1px solid ${C.border}`, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.border}`, background: C.surfaceHover }}>
                <div style={{ fontSize: '18px', fontWeight: 600 }}>{ndcResult.drugName}</div>
                <div style={{ fontFamily: F.mono, fontSize: '12px', color: C.textMuted, marginTop: '4px' }}>NDC: {ndcResult.ndc}</div>
              </div>
              <div style={{ padding: '16px 20px' }}>
                {[['Strength', ndcResult.strength], ['Form', ndcResult.form], ['Labeler', ndcResult.labeler],
                  ['Brand', ndcResult.brandName || '—'], ['DEA', ndcResult.deaSchedule || 'None'],
                  ['Package', ndcResult.packageDescription || '—']
                ].map(([l, v]) => (
                  <div key={l} style={{ display: 'flex', padding: '6px 0', borderBottom: `1px solid ${C.border}22` }}>
                    <span style={{ width: '100px', fontFamily: F.mono, fontSize: '11px', color: C.textMuted, flexShrink: 0 }}>{l}</span>
                    <span style={{ fontSize: '14px' }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Style helpers ────────────────────────────────────────────────────

function inputStyle() {
  return {
    width: '100%', padding: '8px 12px', background: C.surface,
    border: `1px solid ${C.border}`, borderRadius: '6px', color: C.text,
    fontFamily: F.sans, fontSize: '14px', outline: 'none', boxSizing: 'border-box',
  };
}
function labelStyle() {
  return { fontFamily: F.mono, fontSize: '10px', color: C.textDim, letterSpacing: '0.5px', display: 'block', marginBottom: '4px' };
}
function dropdownStyle() {
  return {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px',
    marginTop: '4px', maxHeight: '250px', overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  };
}
function dropdownItemStyle() {
  return {
    padding: '8px 12px', cursor: 'pointer', fontSize: '13px',
    borderBottom: `1px solid ${C.border}22`, transition: 'background 0.1s',
  };
}
function clearBtnStyle() {
  return {
    padding: '8px 14px', background: 'transparent', border: `1px solid ${C.border}`,
    borderRadius: '6px', color: C.textMuted, cursor: 'pointer',
    fontFamily: F.mono, fontSize: '11px',
  };
}

// ─── Mock handler ─────────────────────────────────────────────────────

function mockHandler(cmd, args) {
  switch (cmd) {
    case 'get_drug_names':
      return [
        { drugId: 1, name: 'metoprolol tartrate', drugClass: 'Beta Blocker' },
        { drugId: 2, name: 'metformin hydrochloride', drugClass: 'Biguanide' },
      ].filter(d => d.name.includes((args.query || '').toLowerCase()));
    case 'get_dose_options':
      return [{ strengthId: 1, strength: '25 mg', strengthNum: 25 }, { strengthId: 2, strength: '50 mg', strengthNum: 50 }];
    case 'get_form_options':
      return [{ formId: 1, form: 'tablet', route: 'oral' }];
    case 'search_clinical_products':
      return [{
        clinicalId: 1, drugId: 1, drugName: 'metformin hydrochloride',
        strengthId: 2, strength: '500 mg', form: 'tablet', route: 'oral',
        drugClass: 'Biguanide', deaSchedule: null,
        manufacturers: [{ productId: 1, labeler: 'Mylan', productName: null, isBrand: false, ndcs: [{ ndcId: 1, ndcCode: '00378-0532-01', packageDesc: '100 ct' }] }],
      }];
    case 'lookup_ndc':
      return { ndc: args.ndc, drugName: 'metoprolol tartrate', strength: '50 mg', form: 'tablet', labeler: 'Mylan', brandName: null, deaSchedule: null, packageDescription: '100 ct' };
    default: return null;
  }
}
