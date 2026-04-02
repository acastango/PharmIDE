use crate::db;
use crate::models::*;
use rusqlite::OptionalExtension;

/// Normalize an NDC to 5-4-2 format with leading zeros.
/// Input can be: "1234-5678-90", "1234567890", "12345-678-9", etc.
/// Output: "01234-5678-90" (always 5-4-2 dashed)
fn normalize_ndc(raw: &str) -> String {
    let raw = raw.trim();

    // If it has dashes, split and pad each segment
    if raw.contains('-') {
        let parts: Vec<&str> = raw.splitn(3, '-').collect();
        if parts.len() == 3 {
            let seg1 = format!("{:0>5}", parts[0]);
            let seg2 = format!("{:0>4}", parts[1]);
            let seg3 = format!("{:0>2}", parts[2]);
            return format!("{}-{}-{}", seg1, seg2, seg3);
        }
    }

    // No dashes — strip non-digits, pad to 11, then format
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    let padded = format!("{:0>11}", digits);
    format!("{}-{}-{}", &padded[0..5], &padded[5..9], &padded[9..11])
}

/// Lightweight drug search — returns drug/strength/form combos WITHOUT
/// loading manufacturers or NDCs. Fast enough for typeahead.
#[tauri::command]
pub fn search_drugs_fast(
    drug_name: Option<String>,
    dose: Option<String>,
    form: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<DrugSearchHit>, String> {
    let conn = db::get();
    let limit = limit.unwrap_or(50);

    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    if let Some(ref name) = drug_name {
        let terms: Vec<String> = name
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_lowercase())
            .collect();
        for term in &terms {
            where_clauses.push(format!("LOWER(d.generic_name) LIKE ?{}", param_idx));
            params.push(Box::new(format!("%{}%", term)));
            param_idx += 1;
        }
    }

    if let Some(ref d) = dose {
        let d_clean = d.trim().to_lowercase();
        if !d_clean.is_empty() {
            where_clauses.push(format!("LOWER(s.strength_value) LIKE ?{}", param_idx));
            params.push(Box::new(format!("%{}%", d_clean)));
            param_idx += 1;
        }
    }

    if let Some(ref f) = form {
        let f_clean = f.trim().to_lowercase();
        if !f_clean.is_empty() {
            where_clauses.push(format!("LOWER(fm.form_name) LIKE ?{}", param_idx));
            params.push(Box::new(format!("%{}%", f_clean)));
            param_idx += 1;
        }
    }

    if where_clauses.is_empty() {
        return Ok(vec![]);
    }

    let starts_with = drug_name
        .as_ref()
        .and_then(|n| n.split_whitespace().next())
        .map(|t| format!("{}%", t.to_lowercase()))
        .unwrap_or_else(|| "%".to_string());

    let order_param_idx = param_idx;
    params.push(Box::new(starts_with));
    param_idx += 1;

    let limit_param_idx = param_idx;
    params.push(Box::new(limit));

    let sql = format!(
        "SELECT DISTINCT
            d.drug_id,
            d.generic_name,
            s.strength_value,
            fm.form_name,
            fm.route,
            d.drug_class,
            d.dea_schedule
         FROM form fm
         JOIN strength s ON fm.strength_id = s.strength_id
         JOIN drug d ON s.drug_id = d.drug_id
         WHERE {}
         ORDER BY
           CASE WHEN LOWER(d.generic_name) LIKE ?{} THEN 0 ELSE 1 END,
           LENGTH(d.generic_name) ASC,
           d.generic_name ASC,
           s.strength_num ASC,
           fm.form_name ASC
         LIMIT ?{}",
        where_clauses.join(" AND "),
        order_param_idx,
        limit_param_idx
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let results = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(DrugSearchHit {
                drug_id: row.get(0)?,
                drug_name: row.get(1)?,
                strength: row.get(2)?,
                form: row.get(3)?,
                route: row.get(4)?,
                drug_class: row.get(5)?,
                dea_schedule: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(results)
}

/// Structured search: DRUG NAME, DOSE, FORM — three distinct filters.
/// Returns clinical products (drug + strength + form convergence points)
/// with all their NDCs grouped by manufacturer.
#[tauri::command]
pub fn search_clinical_products(
    drug_name: Option<String>,
    dose: Option<String>,
    form: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ClinicalProduct>, String> {
    let conn = db::get();
    let limit = limit.unwrap_or(50);

    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    // Drug name filter
    if let Some(ref name) = drug_name {
        let terms: Vec<String> = name
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_lowercase())
            .collect();

        for term in &terms {
            where_clauses.push(format!("LOWER(d.generic_name) LIKE ?{}", param_idx));
            params.push(Box::new(format!("%{}%", term)));
            param_idx += 1;
        }
    }

    // Dose/strength filter
    if let Some(ref d) = dose {
        let d_clean = d.trim().to_lowercase();
        if !d_clean.is_empty() {
            where_clauses.push(format!("LOWER(s.strength_value) LIKE ?{}", param_idx));
            params.push(Box::new(format!("%{}%", d_clean)));
            param_idx += 1;
        }
    }

    // Form filter
    if let Some(ref f) = form {
        let f_clean = f.trim().to_lowercase();
        if !f_clean.is_empty() {
            where_clauses.push(format!("LOWER(fm.form_name) LIKE ?{}", param_idx));
            params.push(Box::new(format!("%{}%", f_clean)));
            param_idx += 1;
        }
    }

    if where_clauses.is_empty() {
        return Ok(vec![]);
    }

    // Add starts-with param for ordering (uses first drug name term)
    let starts_with = drug_name
        .as_ref()
        .and_then(|n| n.split_whitespace().next())
        .map(|t| format!("{}%", t.to_lowercase()))
        .unwrap_or_else(|| "%".to_string());

    let order_param_idx = param_idx;
    params.push(Box::new(starts_with));
    param_idx += 1;

    let limit_param_idx = param_idx;
    params.push(Box::new(limit));

    let sql = format!(
        "SELECT DISTINCT
            fm.form_id AS clinical_id,
            d.drug_id,
            d.generic_name,
            s.strength_id,
            s.strength_value,
            fm.form_name,
            fm.route,
            d.drug_class,
            d.dea_schedule
         FROM form fm
         JOIN strength s ON fm.strength_id = s.strength_id
         JOIN drug d ON s.drug_id = d.drug_id
         WHERE {}
         ORDER BY
           CASE WHEN LOWER(d.generic_name) LIKE ?{} THEN 0 ELSE 1 END,
           LENGTH(d.generic_name) ASC,
           d.generic_name ASC,
           s.strength_num ASC,
           fm.form_name ASC
         LIMIT ?{}",
        where_clauses.join(" AND "),
        order_param_idx,
        limit_param_idx
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let products = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(ClinicalProduct {
                clinical_id: row.get(0)?,
                drug_id: row.get(1)?,
                drug_name: row.get(2)?,
                strength_id: row.get(3)?,
                strength: row.get(4)?,
                form: row.get(5)?,
                route: row.get(6)?,
                drug_class: row.get(7)?,
                dea_schedule: row.get(8)?,
                manufacturers: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Now load manufacturers + NDCs for each clinical product
    let mut results = Vec::new();
    for mut cp in products {
        let mut mfr_stmt = conn
            .prepare(
                "SELECT p.product_id, p.labeler_name, p.product_name, p.is_brand
                 FROM product p
                 WHERE p.form_id = ?
                 ORDER BY p.is_brand DESC, p.labeler_name ASC"
            )
            .map_err(|e| e.to_string())?;

        let manufacturers = mfr_stmt
            .query_map([cp.clinical_id], |row| {
                Ok(ManufacturerInfo {
                    product_id: row.get(0)?,
                    labeler: row.get(1)?,
                    product_name: row.get(2)?,
                    is_brand: row.get::<_, i64>(3).unwrap_or(0) != 0,
                    ndcs: vec![],
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut mfrs_with_ndcs = Vec::new();
        for mut mfr in manufacturers {
            let mut ndc_stmt = conn
                .prepare(
                    "SELECT ndc_id, ndc_code, package_desc
                     FROM ndc WHERE product_id = ?
                     ORDER BY ndc_code"
                )
                .map_err(|e| e.to_string())?;

            mfr.ndcs = ndc_stmt
                .query_map([mfr.product_id], |row| {
                    Ok(NdcInfo {
                        ndc_id: row.get(0)?,
                        ndc_code: row.get::<_, String>(1)?,
                        package_desc: row.get(2)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            // Normalize all NDCs to 5-4-2 format
            for ndc in &mut mfr.ndcs {
                ndc.ndc_code = normalize_ndc(&ndc.ndc_code);
            }

            mfrs_with_ndcs.push(mfr);
        }

        cp.manufacturers = mfrs_with_ndcs;
        results.push(cp);
    }

    Ok(results)
}

/// Get all unique drug names for autocomplete
#[tauri::command]
pub fn get_drug_names(query: String, limit: Option<i64>) -> Result<Vec<DrugNameSuggestion>, String> {
    let conn = db::get();
    let limit = limit.unwrap_or(20);
    let q = query.trim().to_lowercase();

    if q.len() < 2 {
        return Ok(vec![]);
    }

    let mut stmt = conn
        .prepare(
            "SELECT drug_id, generic_name, drug_class
             FROM drug
             WHERE LOWER(generic_name) LIKE ?1
             ORDER BY
               CASE WHEN LOWER(generic_name) LIKE ?2 THEN 0 ELSE 1 END,
               LENGTH(generic_name) ASC,
               generic_name ASC
             LIMIT ?3"
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map(
            rusqlite::params![format!("%{}%", q), format!("{}%", q), limit],
            |row| {
                Ok(DrugNameSuggestion {
                    drug_id: row.get(0)?,
                    name: row.get(1)?,
                    drug_class: row.get(2)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Get available strengths for a specific drug
#[tauri::command]
pub fn get_dose_options(drug_id: i64) -> Result<Vec<DoseOption>, String> {
    let conn = db::get();
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT s.strength_id, s.strength_value, s.strength_num
             FROM strength s
             WHERE s.drug_id = ?
             ORDER BY s.strength_num ASC, s.strength_value ASC"
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map([drug_id], |row| {
            Ok(DoseOption {
                strength_id: row.get(0)?,
                strength: row.get(1)?,
                strength_num: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Get available forms for a specific drug + strength combo
#[tauri::command]
pub fn get_form_options(strength_id: i64) -> Result<Vec<FormOption>, String> {
    let conn = db::get();
    let mut stmt = conn
        .prepare(
            "SELECT fm.form_id, fm.form_name, fm.route
             FROM form fm
             WHERE fm.strength_id = ?
             ORDER BY fm.form_name ASC"
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map([strength_id], |row| {
            Ok(FormOption {
                form_id: row.get(0)?,
                form: row.get(1)?,
                route: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ─── Keep the original commands for backward compat ────────────────

#[tauri::command]
pub fn search_drugs(
    query: String,
    limit: Option<i64>,
    community_only: Option<bool>,
) -> Result<Vec<DrugSearchResult>, String> {
    let conn = db::get();
    let limit = limit.unwrap_or(20);
    let _ = community_only;

    let terms: Vec<String> = query
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect();

    if terms.is_empty() {
        return Ok(vec![]);
    }

    let where_clauses: Vec<String> = terms
        .iter()
        .enumerate()
        .map(|(i, _)| format!("LOWER(d.generic_name) LIKE ?{}", i + 1))
        .collect();

    let starts_with_param = terms.len() + 1;
    let limit_param = terms.len() + 2;

    let sql = format!(
        "SELECT d.drug_id, d.generic_name, d.drug_class, d.dea_schedule,
                (SELECT COUNT(*) FROM strength s WHERE s.drug_id = d.drug_id) as strength_count
         FROM drug d
         WHERE {}
         ORDER BY
           CASE WHEN LOWER(d.generic_name) LIKE ?{} THEN 0 ELSE 1 END,
           LENGTH(d.generic_name) ASC,
           d.generic_name ASC
         LIMIT ?{}",
        where_clauses.join(" AND "),
        starts_with_param,
        limit_param
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = terms
        .iter()
        .map(|t| Box::new(format!("%{}%", t)) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    params.push(Box::new(format!("{}%", terms[0])));
    params.push(Box::new(limit));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let results = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(DrugSearchResult {
                id: row.get(0)?,
                name: row.get(1)?,
                pharm_class: row.get(2)?,
                dea_schedule: row.get(3)?,
                is_brand: false,
                community_rank: None,
                strength_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_strengths(drug_id: i64) -> Result<Vec<Strength>, String> {
    let conn = db::get();
    let mut stmt = conn
        .prepare(
            "SELECT strength_id, drug_id, strength_value
             FROM strength WHERE drug_id = ?
             ORDER BY strength_num ASC, strength_value ASC"
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map([drug_id], |row| {
            Ok(Strength {
                id: row.get(0)?,
                drug_id: row.get(1)?,
                strength: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_forms(strength_id: i64) -> Result<Vec<Form>, String> {
    let conn = db::get();
    let mut stmt = conn
        .prepare(
            "SELECT form_id, strength_id, form_name
             FROM form WHERE strength_id = ?
             ORDER BY form_name ASC"
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map([strength_id], |row| {
            Ok(Form {
                id: row.get(0)?,
                strength_id: row.get(1)?,
                form: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_products(form_id: i64) -> Result<Vec<Product>, String> {
    let conn = db::get();
    let mut stmt = conn
        .prepare(
            "SELECT p.product_id, p.form_id, p.labeler_name, p.product_name, p.is_brand,
                    (SELECT COUNT(*) FROM ndc n WHERE n.product_id = p.product_id) as ndc_count,
                    (SELECT n.ndc_code FROM ndc n WHERE n.product_id = p.product_id ORDER BY n.ndc_code LIMIT 1) as first_ndc
             FROM product p
             WHERE p.form_id = ?
             ORDER BY p.labeler_name ASC"
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map([form_id], |row| {
            Ok(Product {
                id: row.get(0)?,
                form_id: row.get(1)?,
                labeler: row.get(2)?,
                brand_name: row.get(3)?,
                is_brand: row.get::<_, i64>(4).unwrap_or(0) != 0,
                ndc_count: row.get(5)?,
                first_ndc: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut products: Vec<Product> = results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    for p in &mut products {
        p.first_ndc = p.first_ndc.as_ref().map(|n| normalize_ndc(n));
    }
    Ok(products)
}

/// Get ALL dispensable products for a drug_id in one query.
/// Returns NDC-level rows with strength and form info included.
#[tauri::command]
pub fn get_drug_dispensable_products(drug_id: i64) -> Result<Vec<DrugDispensableProduct>, String> {
    let conn = db::get();
    let mut stmt = conn
        .prepare(
            "SELECT n.ndc_id, n.ndc_code, p.product_id, p.labeler_name, p.product_name,
                    p.is_brand, n.package_size, n.package_unit, n.package_desc,
                    s.strength_value, fm.form_name, fm.route
             FROM ndc n
             JOIN product p ON n.product_id = p.product_id
             JOIN form fm ON p.form_id = fm.form_id
             JOIN strength s ON fm.strength_id = s.strength_id
             WHERE s.drug_id = ? AND n.obsolete = 0
             ORDER BY s.sort_order ASC, s.strength_num ASC,
                      fm.form_name ASC, p.is_brand DESC,
                      p.labeler_name ASC, n.package_size ASC"
        )
        .map_err(|e| e.to_string())?;

    let mut results: Vec<DrugDispensableProduct> = stmt
        .query_map([drug_id], |row| {
            Ok(DrugDispensableProduct {
                ndc_id: row.get(0)?,
                ndc: row.get::<_, String>(1)?,
                product_id: row.get(2)?,
                labeler: row.get(3)?,
                product_name: row.get(4)?,
                is_brand: row.get::<_, i64>(5).unwrap_or(0) != 0,
                package_size: row.get(6)?,
                package_unit: row.get(7)?,
                package_desc: row.get(8)?,
                strength: row.get(9)?,
                form: row.get(10)?,
                route: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for dp in &mut results {
        dp.ndc = normalize_ndc(&dp.ndc);
    }
    Ok(results)
}

/// Get all dispensable products (NDC-level) for a given form_id.
/// Each row = one specific package on the shelf.
#[tauri::command]
pub fn get_dispensable_products(form_id: i64) -> Result<Vec<DispensableProduct>, String> {
    let conn = db::get();
    let mut stmt = conn
        .prepare(
            "SELECT n.ndc_id, n.ndc_code, p.product_id, p.labeler_name, p.product_name,
                    p.is_brand, n.package_size, n.package_unit, n.package_desc
             FROM ndc n
             JOIN product p ON n.product_id = p.product_id
             WHERE p.form_id = ? AND n.obsolete = 0
             ORDER BY p.is_brand DESC, p.labeler_name ASC, n.package_size ASC"
        )
        .map_err(|e| e.to_string())?;

    let mut results: Vec<DispensableProduct> = stmt
        .query_map([form_id], |row| {
            Ok(DispensableProduct {
                ndc_id: row.get(0)?,
                ndc: row.get::<_, String>(1)?,
                product_id: row.get(2)?,
                labeler: row.get(3)?,
                product_name: row.get(4)?,
                is_brand: row.get::<_, i64>(5).unwrap_or(0) != 0,
                package_size: row.get(6)?,
                package_unit: row.get(7)?,
                package_desc: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for dp in &mut results {
        dp.ndc = normalize_ndc(&dp.ndc);
    }
    Ok(results)
}

#[tauri::command]
pub fn lookup_ndc(ndc: String) -> Result<Option<NdcLookup>, String> {
    let conn = db::get();

    // DB layout (confirmed from schema):
    //   ndc_code  — 4-4-2 dashed, no leading zero on labeler segment  e.g. "0093-2267-01"
    //   ndc_11    — plain 11-digit with leading zero                  e.g. "00093226701"
    //
    // Strategy: normalise any input to 11 digits and match against ndc_11.
    // This covers all common user input formats:
    //   "00093-2267-01"  (5-4-2) → strip dashes → "00093226701" (11 digits) → exact match
    //   "0093-2267-01"   (4-4-2) → strip dashes → "0093226701"  (10 digits) → pad → "00093226701"
    //   "00093226701"    (plain 11)                              (11 digits) → exact match
    //   "0093226701"     (plain 10)                             (10 digits) → pad → "00093226701"
    let digits: String = ndc.chars().filter(|c| c.is_ascii_digit()).collect();
    let ndc_11 = format!("{:0>11}", &digits);

    let result = conn
        .query_row(
            "SELECT n.ndc_code, d.generic_name, s.strength_value, f.form_name,
                    p.labeler_name, p.product_name, d.dea_schedule, n.package_desc
             FROM ndc n
             JOIN product p ON n.product_id = p.product_id
             JOIN form f ON p.form_id = f.form_id
             JOIN strength s ON f.strength_id = s.strength_id
             JOIN drug d ON s.drug_id = d.drug_id
             WHERE n.ndc_11 = ?1",
            rusqlite::params![ndc_11],
            |row| {
                Ok(NdcLookup {
                    ndc: row.get(0)?,
                    drug_name: row.get(1)?,
                    strength: row.get(2)?,
                    form: row.get(3)?,
                    labeler: row.get(4)?,
                    brand_name: row.get(5)?,
                    dea_schedule: row.get(6)?,
                    package_description: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result.map(|mut r| { r.ndc = normalize_ndc(&r.ndc); r }))
}

#[tauri::command]
pub fn get_drug_tree(drug_id: i64) -> Result<Option<DrugTree>, String> {
    let conn = db::get();

    let drug = conn
        .query_row(
            "SELECT drug_id, generic_name, drug_class, dea_schedule
             FROM drug WHERE drug_id = ?",
            [drug_id],
            |row| {
                Ok(Drug {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    pharm_class: row.get(2)?,
                    dea_schedule: row.get(3)?,
                    is_brand: false,
                    community_rank: None,
                    is_community_top200: false,
                    is_community_common: false,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let drug = match drug {
        Some(d) => d,
        None => return Ok(None),
    };

    let strengths = get_strengths(drug_id)?;
    let mut strength_nodes = Vec::new();

    for s in strengths {
        let forms = get_forms(s.id)?;
        let mut form_nodes = Vec::new();

        for f in forms {
            let products = get_products(f.id)?;
            let mut product_nodes = Vec::new();

            for p in products {
                let mut ndc_stmt = conn
                    .prepare(
                        "SELECT ndc_id, product_id, ndc_code, package_desc
                         FROM ndc WHERE product_id = ? ORDER BY ndc_code",
                    )
                    .map_err(|e| e.to_string())?;

                let mut ndcs = ndc_stmt
                    .query_map([p.id], |row| {
                        Ok(Ndc {
                            id: row.get(0)?,
                            product_id: row.get(1)?,
                            ndc: row.get::<_, String>(2)?,
                            package_description: row.get(3)?,
                        })
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;

                for n in &mut ndcs {
                    n.ndc = normalize_ndc(&n.ndc);
                }

                product_nodes.push(ProductNode { product: p, ndcs });
            }

            form_nodes.push(FormNode {
                form: f,
                products: product_nodes,
            });
        }

        strength_nodes.push(StrengthNode {
            strength: s,
            forms: form_nodes,
        });
    }

    Ok(Some(DrugTree {
        drug,
        strengths: strength_nodes,
    }))
}
