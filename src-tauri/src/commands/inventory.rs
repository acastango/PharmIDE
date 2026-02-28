use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

static INVENTORY_DB: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Initialize the inventory database (separate from drug_tree.db).
/// Creates the table if it doesn't exist.
pub fn init_inventory(path: &str) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| format!("Failed to open inventory DB: {}", e))?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;

         CREATE TABLE IF NOT EXISTS inventory (
             ndc_code        TEXT PRIMARY KEY,
             on_hand         INTEGER NOT NULL DEFAULT 0,
             reorder_point   INTEGER,
             shelf_location  TEXT,
             lot_number      TEXT,
             expiration      TEXT,
             last_counted    TEXT,
             notes           TEXT,
             updated_at      TEXT DEFAULT (datetime('now'))
         );

         CREATE INDEX IF NOT EXISTS idx_inventory_shelf
             ON inventory(shelf_location);
        "
    ).map_err(|e| format!("Failed to create inventory tables: {}", e))?;

    INVENTORY_DB.set(Mutex::new(conn))
        .map_err(|_| "Inventory DB already initialized".to_string())
}

fn get_inv() -> std::sync::MutexGuard<'static, Connection> {
    INVENTORY_DB.get().expect("Inventory DB not initialized").lock().unwrap()
}

// ─── Models ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRecord {
    pub ndc_code: String,
    pub on_hand: i64,
    pub reorder_point: Option<i64>,
    pub shelf_location: Option<String>,
    pub lot_number: Option<String>,
    pub expiration: Option<String>,
    pub last_counted: Option<String>,
    pub notes: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUpdate {
    pub ndc_code: String,
    pub on_hand: Option<i64>,
    pub reorder_point: Option<i64>,
    pub shelf_location: Option<String>,
    pub lot_number: Option<String>,
    pub expiration: Option<String>,
    pub notes: Option<String>,
}

// ─── Commands ─────────────────────────────────────────────────────────

/// Get inventory record for a single NDC
#[tauri::command]
pub fn get_inventory(ndc_code: String) -> Result<Option<InventoryRecord>, String> {
    let conn = get_inv();
    let mut stmt = conn.prepare(
        "SELECT ndc_code, on_hand, reorder_point, shelf_location,
                lot_number, expiration, last_counted, notes, updated_at
         FROM inventory WHERE ndc_code = ?"
    ).map_err(|e| e.to_string())?;

    let result = stmt.query_row([&ndc_code], |row| {
        Ok(InventoryRecord {
            ndc_code: row.get(0)?,
            on_hand: row.get(1)?,
            reorder_point: row.get(2)?,
            shelf_location: row.get(3)?,
            lot_number: row.get(4)?,
            expiration: row.get(5)?,
            last_counted: row.get(6)?,
            notes: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }).optional().map_err(|e| e.to_string())?;

    Ok(result)
}

/// Get inventory for multiple NDCs at once (batch lookup)
#[tauri::command]
pub fn get_inventory_batch(ndc_codes: Vec<String>) -> Result<Vec<InventoryRecord>, String> {
    if ndc_codes.is_empty() { return Ok(vec![]); }

    let conn = get_inv();
    let placeholders: Vec<String> = ndc_codes.iter().enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();

    let sql = format!(
        "SELECT ndc_code, on_hand, reorder_point, shelf_location,
                lot_number, expiration, last_counted, notes, updated_at
         FROM inventory WHERE ndc_code IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::types::ToSql> = ndc_codes.iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let results = stmt.query_map(params.as_slice(), |row| {
        Ok(InventoryRecord {
            ndc_code: row.get(0)?,
            on_hand: row.get(1)?,
            reorder_point: row.get(2)?,
            shelf_location: row.get(3)?,
            lot_number: row.get(4)?,
            expiration: row.get(5)?,
            last_counted: row.get(6)?,
            notes: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }).map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Update inventory for a single NDC (upsert)
#[tauri::command]
pub fn update_inventory(update: InventoryUpdate) -> Result<InventoryRecord, String> {
    let conn = get_inv();
    let ndc = update.ndc_code.clone();

    conn.execute(
        "INSERT INTO inventory (ndc_code, on_hand, reorder_point, shelf_location, lot_number, expiration, notes, last_counted, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))
         ON CONFLICT(ndc_code) DO UPDATE SET
             on_hand = COALESCE(?2, on_hand),
             reorder_point = COALESCE(?3, reorder_point),
             shelf_location = COALESCE(?4, shelf_location),
             lot_number = COALESCE(?5, lot_number),
             expiration = COALESCE(?6, expiration),
             notes = COALESCE(?7, notes),
             last_counted = datetime('now'),
             updated_at = datetime('now')",
        params![
            update.ndc_code,
            update.on_hand,
            update.reorder_point,
            update.shelf_location,
            update.lot_number,
            update.expiration,
            update.notes,
        ],
    ).map_err(|e| e.to_string())?;

    // Read back with same connection (no second lock)
    conn.query_row(
        "SELECT ndc_code, on_hand, reorder_point, shelf_location,
                lot_number, expiration, last_counted, notes, updated_at
         FROM inventory WHERE ndc_code = ?",
        [&ndc],
        |row| {
            Ok(InventoryRecord {
                ndc_code: row.get(0)?,
                on_hand: row.get(1)?,
                reorder_point: row.get(2)?,
                shelf_location: row.get(3)?,
                lot_number: row.get(4)?,
                expiration: row.get(5)?,
                last_counted: row.get(6)?,
                notes: row.get(7)?,
                updated_at: row.get(8)?,
            })
        }
    ).map_err(|e| e.to_string())
}

/// Adjust on-hand by a delta (positive = received, negative = dispensed)
#[tauri::command]
pub fn adjust_on_hand(ndc_code: String, delta: i64) -> Result<InventoryRecord, String> {
    let conn = get_inv();

    conn.execute(
        "INSERT OR IGNORE INTO inventory (ndc_code, on_hand) VALUES (?1, 0)",
        [&ndc_code],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE inventory SET on_hand = MAX(0, on_hand + ?2), updated_at = datetime('now') WHERE ndc_code = ?1",
        params![ndc_code, delta],
    ).map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT ndc_code, on_hand, reorder_point, shelf_location,
                lot_number, expiration, last_counted, notes, updated_at
         FROM inventory WHERE ndc_code = ?",
        [&ndc_code],
        |row| {
            Ok(InventoryRecord {
                ndc_code: row.get(0)?,
                on_hand: row.get(1)?,
                reorder_point: row.get(2)?,
                shelf_location: row.get(3)?,
                lot_number: row.get(4)?,
                expiration: row.get(5)?,
                last_counted: row.get(6)?,
                notes: row.get(7)?,
                updated_at: row.get(8)?,
            })
        }
    ).map_err(|e| e.to_string())
}

use rusqlite::OptionalExtension;
