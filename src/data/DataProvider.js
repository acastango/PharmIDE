const isTauri = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

let invoke;

async function getInvoke() {
  if (invoke) return invoke;
  if (isTauri()) {
    const tauri = await import('@tauri-apps/api/core');
    invoke = tauri.invoke;
  } else {
    invoke = async (cmd, args) => {
      console.warn(`[DataProvider] Mock invoke: ${cmd}`, args);
      return mockHandler(cmd, args);
    };
  }
  return invoke;
}

export const DataProvider = {
  async searchDrugs(query, options = {}) {
    const fn = await getInvoke();
    return fn('search_drugs', {
      query,
      limit: options.limit || 20,
      communityOnly: options.communityOnly ?? true,
    });
  },

  async getStrengths(drugId) {
    const fn = await getInvoke();
    return fn('get_strengths', { drugId });
  },

  async getForms(strengthId) {
    const fn = await getInvoke();
    return fn('get_forms', { strengthId });
  },

  async getProducts(formId) {
    const fn = await getInvoke();
    return fn('get_products', { formId });
  },

  async lookupNdc(ndc) {
    const fn = await getInvoke();
    return fn('lookup_ndc', { ndc });
  },

  async getDrugTree(drugId) {
    const fn = await getInvoke();
    return fn('get_drug_tree', { drugId });
  },

  async getQueueState() {
    const fn = await getInvoke();
    return fn('get_queue_state', {});
  },

  async updateRxStatus(rxId, newStatus, userId) {
    const fn = await getInvoke();
    return fn('update_rx_status', { rxId, newStatus, userId });
  },
};

function mockHandler(cmd, args) {
  switch (cmd) {
    case 'search_drugs':
      return [
        { id: 1, name: 'metoprolol tartrate', pharm_class: 'Beta Blocker',
          dea_schedule: null, is_brand: false, community_rank: 4, strength_count: 5 },
        { id: 2, name: 'metoprolol succinate', pharm_class: 'Beta Blocker',
          dea_schedule: null, is_brand: false, community_rank: 7, strength_count: 4 },
      ].filter(d => d.name.includes((args.query || '').toLowerCase()));
    case 'get_strengths':
      return [
        { id: 1, drug_id: args.drugId, strength: '25 mg' },
        { id: 2, drug_id: args.drugId, strength: '50 mg' },
        { id: 3, drug_id: args.drugId, strength: '100 mg' },
      ];
    case 'get_forms':
      return [{ id: 1, strength_id: args.strengthId, form: 'tablet' }];
    case 'get_products':
      return [{ id: 1, form_id: args.formId, labeler: 'Mylan Pharmaceuticals',
                brand_name: null, ndc_count: 2 }];
    case 'lookup_ndc':
      return { ndc: args.ndc, drug_name: 'metoprolol tartrate', strength: '50 mg',
               form: 'tablet', labeler: 'Mylan', brand_name: null,
               dea_schedule: null, package_description: '100 tablets/bottle' };
    case 'get_queue_state':
      return { items: [], current_user: 'dev-tech' };
    case 'update_rx_status':
      return null;
    default:
      return null;
  }
}

export default DataProvider;
