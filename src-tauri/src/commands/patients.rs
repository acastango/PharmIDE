use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

fn get_db() -> std::sync::MutexGuard<'static, Connection> {
    crate::app_db::get_conn()
}

// ─── Model ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Patient {
    pub id: String,
    pub name: String,
    pub dob: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    /// JSON string — array of allergy names
    pub allergies: Option<String>,
    /// JSON string — insurance object
    pub insurance: Option<String>,
    /// JSON string — array of medication objects
    pub medications: Option<String>,
    pub notes: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

fn row_to_patient(row: &rusqlite::Row) -> rusqlite::Result<Patient> {
    Ok(Patient {
        id:          row.get(0)?,
        name:        row.get(1)?,
        dob:         row.get(2)?,
        phone:       row.get(3)?,
        address:     row.get(4)?,
        allergies:   row.get(5)?,
        insurance:   row.get(6)?,
        medications: row.get(7)?,
        notes:       row.get(8)?,
        created_at:  row.get(9)?,
        updated_at:  row.get(10)?,
    })
}

// ─── Commands ─────────────────────────────────────────────────────────

/// Fetch a single patient by internal ID.
#[tauri::command]
pub fn get_patient(id: String) -> Result<Option<Patient>, String> {
    let conn = get_db();
    conn.query_row(
        "SELECT id, name, dob, phone, address, allergies, insurance,
                medications, notes, created_at, updated_at
         FROM patients WHERE id = ?1",
        params![id],
        row_to_patient,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Insert or update a patient record.
/// If the ID already exists, all fields are overwritten and updated_at is refreshed.
#[tauri::command]
pub fn upsert_patient(patient: Patient) -> Result<Patient, String> {
    let conn = get_db();
    conn.execute(
        "INSERT INTO patients
             (id, name, dob, phone, address, allergies, insurance, medications, notes,
              created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 COALESCE((SELECT created_at FROM patients WHERE id = ?1),
                           strftime('%Y-%m-%dT%H:%M:%f','now')),
                 strftime('%Y-%m-%dT%H:%M:%f','now'))
         ON CONFLICT(id) DO UPDATE SET
             name        = excluded.name,
             dob         = excluded.dob,
             phone       = excluded.phone,
             address     = excluded.address,
             allergies   = excluded.allergies,
             insurance   = excluded.insurance,
             medications = excluded.medications,
             notes       = excluded.notes,
             updated_at  = strftime('%Y-%m-%dT%H:%M:%f','now')",
        params![
            patient.id, patient.name, patient.dob, patient.phone, patient.address,
            patient.allergies, patient.insurance, patient.medications, patient.notes,
        ],
    )
    .map_err(|e| e.to_string())?;

    // Query inline — calling get_patient() would deadlock (re-acquires the same mutex)
    conn.query_row(
        "SELECT id, name, dob, phone, address, allergies, insurance,
                medications, notes, created_at, updated_at
         FROM patients WHERE id = ?1",
        params![patient.id],
        row_to_patient,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "patient not found after upsert".to_string())
}

/// Return all patients, ordered by name.
#[tauri::command]
pub fn get_all_patients() -> Result<Vec<Patient>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, dob, phone, address, allergies, insurance,
                    medications, notes, created_at, updated_at
             FROM patients ORDER BY name ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt
        .query_map([], row_to_patient)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

/// Case-insensitive name search.
#[tauri::command]
pub fn search_patients(query: String) -> Result<Vec<Patient>, String> {
    let conn = get_db();
    let pattern = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT id, name, dob, phone, address, allergies, insurance,
                    medications, notes, created_at, updated_at
             FROM patients WHERE lower(name) LIKE ?1 ORDER BY name ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt
        .query_map(params![pattern], row_to_patient)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}
