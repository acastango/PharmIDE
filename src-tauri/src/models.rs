use serde::{Deserialize, Serialize};

// ─── Clinical Product Search types ────────────────────────────────────

/// A clinical product = the convergence point in the tree.
/// Drug + Strength + Form. Every NDC below this is therapeutically equivalent.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClinicalProduct {
    pub clinical_id: i64,      // form_id — the convergence point
    pub drug_id: i64,
    pub drug_name: String,
    pub strength_id: i64,
    pub strength: String,
    pub form: String,
    pub route: Option<String>,
    pub drug_class: Option<String>,
    pub dea_schedule: Option<String>,
    pub manufacturers: Vec<ManufacturerInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManufacturerInfo {
    pub product_id: i64,
    pub labeler: String,
    pub product_name: Option<String>,
    pub is_brand: bool,
    pub ndcs: Vec<NdcInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NdcInfo {
    pub ndc_id: i64,
    pub ndc_code: String,
    pub package_desc: Option<String>,
}

/// A dispensable product = one specific NDC package on the shelf.
/// This is what a tech actually selects during fill.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispensableProduct {
    pub ndc_id: i64,
    pub ndc: String,
    pub product_id: i64,
    pub labeler: String,
    pub product_name: Option<String>,
    pub is_brand: bool,
    pub package_size: Option<f64>,
    pub package_unit: Option<String>,
    pub package_desc: Option<String>,
}

/// Dispensable product with strength/form info — for drug-level queries.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrugDispensableProduct {
    pub ndc_id: i64,
    pub ndc: String,
    pub product_id: i64,
    pub labeler: String,
    pub product_name: Option<String>,
    pub is_brand: bool,
    pub package_size: Option<f64>,
    pub package_unit: Option<String>,
    pub package_desc: Option<String>,
    pub strength: String,
    pub form: String,
    pub route: Option<String>,
}

/// Drug name autocomplete suggestion
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrugNameSuggestion {
    pub drug_id: i64,
    pub name: String,
    pub drug_class: Option<String>,
}

/// Lightweight search result — no manufacturers/NDCs loaded
/// Used for the Rx Entry search dropdown
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrugSearchHit {
    pub drug_id: i64,
    pub drug_name: String,
    pub strength: String,
    pub form: String,
    pub route: Option<String>,
    pub drug_class: Option<String>,
    pub dea_schedule: Option<String>,
}

/// Dose option for a given drug
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoseOption {
    pub strength_id: i64,
    pub strength: String,
    pub strength_num: Option<f64>,
}

/// Form option for a given drug + strength
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormOption {
    pub form_id: i64,
    pub form: String,
    pub route: Option<String>,
}

// ─── Original tree types (backward compat) ────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drug {
    pub id: i64,
    pub name: String,
    pub pharm_class: Option<String>,
    pub dea_schedule: Option<String>,
    pub is_brand: bool,
    pub community_rank: Option<i64>,
    pub is_community_top200: bool,
    pub is_community_common: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrugSearchResult {
    pub id: i64,
    pub name: String,
    pub pharm_class: Option<String>,
    pub dea_schedule: Option<String>,
    pub is_brand: bool,
    pub community_rank: Option<i64>,
    pub strength_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Strength {
    pub id: i64,
    pub drug_id: i64,
    pub strength: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    pub id: i64,
    pub strength_id: i64,
    pub form: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: i64,
    pub form_id: i64,
    pub labeler: String,
    pub brand_name: Option<String>,
    pub is_brand: bool,
    pub ndc_count: i64,
    pub first_ndc: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ndc {
    pub id: i64,
    pub product_id: i64,
    pub ndc: String,
    pub package_description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrugTree {
    pub drug: Drug,
    pub strengths: Vec<StrengthNode>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthNode {
    pub strength: Strength,
    pub forms: Vec<FormNode>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormNode {
    pub form: Form,
    pub products: Vec<ProductNode>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductNode {
    pub product: Product,
    pub ndcs: Vec<Ndc>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NdcLookup {
    pub ndc: String,
    pub drug_name: String,
    pub strength: String,
    pub form: String,
    pub labeler: String,
    pub brand_name: Option<String>,
    pub dea_schedule: Option<String>,
    pub package_description: Option<String>,
}
