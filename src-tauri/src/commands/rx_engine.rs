use rusqlite::{Connection, OptionalExtension, params};
use roxmltree::Document;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

// Active session held in a global so every log_event call can read it
// without the frontend needing to pass session_id on every command.
static ACTIVE_SESSION: OnceLock<Mutex<Option<ActiveSessionInfo>>> = OnceLock::new();

// ─── DB Init ──────────────────────────────────────────────────────────

pub fn init_pharmide_db() -> Result<(), String> {
    let conn = crate::app_db::get_conn();

    // Static tables — safe to recreate with IF NOT EXISTS on every launch.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;

         CREATE TABLE IF NOT EXISTS rx_counters (
             schedule_prefix INTEGER PRIMARY KEY,
             next_number     INTEGER NOT NULL DEFAULT 1
         );
         INSERT OR IGNORE INTO rx_counters VALUES (2, 1);
         INSERT OR IGNORE INTO rx_counters VALUES (3, 1);
         INSERT OR IGNORE INTO rx_counters VALUES (7, 1);

         CREATE TABLE IF NOT EXISTS prescriptions (
             id                   TEXT PRIMARY KEY,
             rx_number            TEXT UNIQUE,
             patient_id           TEXT NOT NULL,
             status               TEXT NOT NULL DEFAULT 'incoming',
             schedule_class       TEXT,
             eorder_data          TEXT,
             tech_entry_data      TEXT,
             rph_review_data      TEXT,
             fill_data            TEXT,
             rph_fill_review_data TEXT,
             created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
             updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
         );
         CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_id);
         CREATE INDEX IF NOT EXISTS idx_rx_status  ON prescriptions(status);
         CREATE INDEX IF NOT EXISTS idx_rx_number  ON prescriptions(rx_number);

         CREATE TABLE IF NOT EXISTS users (
             id   TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             role TEXT NOT NULL
         );
         INSERT OR IGNORE INTO users VALUES ('usr-tech-1', 'Alex Chen',       'tech');
         INSERT OR IGNORE INTO users VALUES ('usr-tech-2', 'Jordan Mills',     'tech');
         INSERT OR IGNORE INTO users VALUES ('usr-rph-1',  'Dr. Sarah Park',   'rph');
         INSERT OR IGNORE INTO users VALUES ('usr-rph-2',  'Dr. Marcus Webb',  'rph');
        ",
    )
    .map_err(|e| format!("Failed to initialize pharmide tables: {}", e))?;

    // ── Schema migration: version 2 = Merkle-chained event_log ──────────
    // On first run with new code (user_version < 2), drop the old event_log
    // (wrong schema) and create the Merkle versions of audit tables.
    // After migration, user_version = 2 prevents re-running on subsequent starts.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);

    if version < 2 {
        conn.execute_batch(
            "DROP TABLE IF EXISTS event_log;
             DROP TABLE IF EXISTS sessions;
             DROP TABLE IF EXISTS activity_log;",
        )
        .map_err(|e| format!("Failed to drop legacy audit tables: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE sessions (
                 id           TEXT PRIMARY KEY,
                 user_id      TEXT NOT NULL,
                 user_role    TEXT NOT NULL,
                 started_at   TEXT NOT NULL,
                 ended_at     TEXT,
                 session_hash TEXT NOT NULL,
                 closing_hash TEXT,
                 FOREIGN KEY (user_id) REFERENCES users(id)
             );
             CREATE INDEX idx_session_user ON sessions(user_id);
             CREATE INDEX idx_session_time ON sessions(started_at);

             CREATE TABLE event_log (
                 id            INTEGER PRIMARY KEY AUTOINCREMENT,
                 event_id      TEXT NOT NULL UNIQUE,
                 timestamp     TEXT NOT NULL,
                 monotonic_ns  INTEGER NOT NULL,
                 event_type    TEXT NOT NULL,
                 action        TEXT NOT NULL,
                 actor_id      TEXT NOT NULL,
                 actor_role    TEXT NOT NULL,
                 session_id    TEXT NOT NULL,
                 session_hash  TEXT NOT NULL,
                 entity_type   TEXT,
                 entity_id     TEXT,
                 rx_id         TEXT,
                 rx_number     TEXT,
                 patient_id    TEXT,
                 old_status    TEXT,
                 new_status    TEXT,
                 payload       TEXT,
                 sequence      INTEGER NOT NULL UNIQUE,
                 previous_hash TEXT NOT NULL,
                 event_hash    TEXT NOT NULL
             );
             CREATE INDEX idx_event_rx        ON event_log(rx_id);
             CREATE INDEX idx_event_patient   ON event_log(patient_id);
             CREATE INDEX idx_event_timestamp ON event_log(timestamp);
             CREATE INDEX idx_event_type      ON event_log(event_type);
             CREATE INDEX idx_event_actor     ON event_log(actor_id);
             CREATE INDEX idx_event_session   ON event_log(session_id);
             CREATE INDEX idx_event_sequence  ON event_log(sequence);

             -- activity_log: UI/debug events, no cryptographic guarantee.
             -- Schema created now; wiring to Tauri commands deferred.
             CREATE TABLE activity_log (
                 id        INTEGER PRIMARY KEY AUTOINCREMENT,
                 timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
                 user_id   TEXT,
                 action    TEXT NOT NULL,
                 details   TEXT
             );

             PRAGMA user_version = 2;",
        )
        .map_err(|e| format!("Failed to create audit tables: {}", e))?;
    }

    // ── Schema migration: version 3 = eorders table ─────────────────────
    // Adds the incoming e-order queue table plus three seed eorders that
    // mirror MOCK_EORDERS so the UI works before SureScripts is wired up.
    if version < 3 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS eorders (
                 id          TEXT PRIMARY KEY,
                 message_id  TEXT UNIQUE NOT NULL,
                 received_at TEXT NOT NULL,
                 patient_id  TEXT,
                 status      TEXT NOT NULL DEFAULT 'pending',
                 raw_xml     TEXT,
                 raw_fields  TEXT NOT NULL,
                 transcribed TEXT NOT NULL,
                 resolved_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_eorder_status   ON eorders(status);
             CREATE INDEX IF NOT EXISTS idx_eorder_patient  ON eorders(patient_id);
             CREATE INDEX IF NOT EXISTS idx_eorder_received ON eorders(received_at);",
        )
        .map_err(|e| format!("Failed to create eorders table: {}", e))?;

        // Seed the three mock eorders so the data-entry queue is populated
        // on a fresh install without a real SureScripts connection.
        conn.execute_batch(
            r#"INSERT OR IGNORE INTO eorders
               (id, message_id, received_at, patient_id, status, raw_fields, transcribed)
             VALUES
               ('eo-seed-1', 'MSG-20260226-001', '2026-02-26T14:32:00Z', 'p1', 'pending',
                '{"messageType":"NEWRX","drugDescription":"Norvasc 5mg Oral Tablet","drugNDC":"00069-1530-30","drugCodedName":"amlodipine besylate","drugStrength":"5 mg","drugForm":"TAB","drugQuantity":"30","drugDaysSupply":"30","refillsAuthorized":"5","substitutionCode":"0","sigText":"TAKE 1 TABLET BY MOUTH ONCE DAILY FOR BLOOD PRESSURE","sigCode":"1 TAB PO QD","prescriberLastName":"Kim","prescriberFirstName":"Sarah","prescriberDEA":"AK1234563","prescriberNPI":"1234567890","prescriberPhone":"9705551100","prescriberAddress":"200 W Mountain Ave, Fort Collins CO 80521","patientLastName":"Johnson","patientFirstName":"Margaret","patientDOB":"19520315","dateWritten":"20260226","note":""}',
                '{"drug":"Norvasc (amlodipine) 5mg tablet","sig":"Take 1 tablet by mouth once daily for blood pressure","qty":30,"daySupply":30,"refills":5,"daw":0,"prescriber":"Dr. Sarah Kim, MD","prescriberDEA":"AK1234563","dateWritten":"02/26/2026","patient":"Margaret Johnson","patientDOB":"03/15/1952","note":""}'
               ),
               ('eo-seed-2', 'MSG-20260226-002', '2026-02-26T15:05:00Z', 'p2', 'pending',
                '{"messageType":"NEWRX","drugDescription":"Singulair 10mg Oral Tablet","drugNDC":"00006-0117-31","drugCodedName":"montelukast sodium","drugStrength":"10 mg","drugForm":"TAB","drugQuantity":"30","drugDaysSupply":"30","refillsAuthorized":"11","substitutionCode":"0","sigText":"TAKE 1 TABLET BY MOUTH AT BEDTIME","sigCode":"1 TAB PO QHS","prescriberLastName":"Park","prescriberFirstName":"James","prescriberDEA":"BP2345674","prescriberNPI":"2345678901","prescriberPhone":"9705551200","prescriberAddress":"1100 Lemay Ave, Fort Collins CO 80524","patientLastName":"Chen","patientFirstName":"David","patientDOB":"19850722","dateWritten":"20260226","note":"Patient reports seasonal allergies worsening"}',
                '{"drug":"Singulair (montelukast) 10mg tablet","sig":"Take 1 tablet by mouth at bedtime","qty":30,"daySupply":30,"refills":11,"daw":0,"prescriber":"Dr. James Park, DO","prescriberDEA":"BP2345674","dateWritten":"02/26/2026","patient":"David Chen","patientDOB":"07/22/1985","note":"Patient reports seasonal allergies worsening"}'
               ),
               ('eo-seed-3', 'MSG-20260226-003', '2026-02-26T13:48:00Z', 'p3', 'pending',
                '{"messageType":"NEWRX","drugDescription":"Toprol-XL 25mg Oral Tablet Extended Release","drugNDC":"00186-1092-05","drugCodedName":"metoprolol succinate","drugStrength":"25 mg","drugForm":"TAB,SA","drugQuantity":"30","drugDaysSupply":"30","refillsAuthorized":"5","substitutionCode":"0","sigText":"TAKE 1 TABLET BY MOUTH ONCE DAILY","sigCode":"1 TAB PO QD","prescriberLastName":"Lopez","prescriberFirstName":"Maria","prescriberDEA":"BL3456785","prescriberNPI":"3456789012","prescriberPhone":"9705551300","prescriberAddress":"1024 S Lemay Ave Ste 200, Fort Collins CO 80524","patientLastName":"Martinez","patientFirstName":"Rosa","patientDOB":"19681103","dateWritten":"20260225","note":"Adding for newly diagnosed HTN - start low dose"}',
                '{"drug":"Toprol-XL (metoprolol succinate) 25mg ER tablet","sig":"Take 1 tablet by mouth once daily","qty":30,"daySupply":30,"refills":5,"daw":0,"prescriber":"Dr. Maria Lopez, MD","prescriberDEA":"BL3456785","dateWritten":"02/25/2026","patient":"Rosa Martinez","patientDOB":"11/03/1968","note":"Adding for newly diagnosed HTN - start low dose"}'
               );

             PRAGMA user_version = 3;"#,
        )
        .map_err(|e| format!("Failed to seed eorders: {}", e))?;
    }

    // ── Schema migration: version 4 = prescribers table ─────────────────
    // Adds persistent prescriber records with name-change tracking.
    // (uses the same `version` read at the top of this function)
    if version < 4 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS prescribers (
                 id               TEXT PRIMARY KEY,
                 first_name       TEXT NOT NULL,
                 last_name        TEXT NOT NULL,
                 former_last_name TEXT,
                 name_changed_at  TEXT,
                 credentials      TEXT,
                 dea              TEXT,
                 npi              TEXT,
                 practice         TEXT,
                 phone            TEXT,
                 fax              TEXT,
                 address          TEXT,
                 specialty        TEXT,
                 notes            TEXT,
                 created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
                 updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
             );
             CREATE INDEX IF NOT EXISTS idx_prescriber_last ON prescribers(last_name);

             INSERT OR IGNORE INTO prescribers (id, first_name, last_name, credentials, dea, npi, practice, phone, specialty)
             VALUES
               ('pres-1', 'James',    'Harrison', 'MD',   'BH1234563', '1234567890', 'Harrison Family Medicine', '555-0101', NULL),
               ('pres-2', 'Maria',    'Chen',     'DO',   'BC9876543', '9876543210', 'Riverside Medical Group',  '555-0102', NULL),
               ('pres-3', 'Robert',   'Williams', 'MD',   'BW5555555', '5555555555', 'Cardiology Associates',    '555-0103', NULL),
               ('pres-4', 'Sarah',    'Thompson', 'NP',   'BT7777777', '7777777777', 'Community Health Center',  '555-0104', NULL),
               ('pres-5', 'Michael',  'Davis',    'MD',   'BD3333333', '3333333333', 'Neurology Partners',       '555-0105', NULL),
               ('pres-6', 'Jennifer', 'Martinez', 'MD',   'BM8888888', '8888888888', 'Oncology Specialists',     '555-0106', NULL),
               ('pres-haiku', 'Claude', 'Haiku',  'LLMD', 'NONE',      'NONE',       'Anthropic',                '9709999999', 'Large Language Prescribing');

             PRAGMA user_version = 4;",
        )
        .map_err(|e| format!("Failed to create prescribers table: {}", e))?;
    }

    // ── Schema migration: version 5 = add Dr. Claude Haiku ──────────────
    if version < 5 {
        conn.execute_batch(
            "INSERT OR IGNORE INTO prescribers (id, first_name, last_name, credentials, dea, npi, practice, phone, specialty)
             VALUES ('pres-haiku', 'Claude', 'Haiku', 'LLMD', 'NONE', 'NONE', 'Anthropic', '9709999999', 'Large Language Prescribing');

             PRAGMA user_version = 5;",
        )
        .map_err(|e| format!("Failed to seed Dr. Claude Haiku: {}", e))?;
    }

    // ── Schema migration: version 6 = patients + fill_history ────────────
    // Consolidates patients.db into pharmide.db and adds immutable fill records.
    if version < 6 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS patients (
                 id          TEXT PRIMARY KEY,
                 name        TEXT NOT NULL,
                 dob         TEXT,
                 phone       TEXT,
                 address     TEXT,
                 allergies   TEXT,
                 insurance   TEXT,
                 medications TEXT,
                 notes       TEXT,
                 created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
                 updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
             );
             CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);

             CREATE TABLE IF NOT EXISTS fill_history (
                 id              TEXT PRIMARY KEY,
                 patient_id      TEXT NOT NULL,
                 rx_id           TEXT NOT NULL,
                 rx_number       TEXT,
                 ndc             TEXT,
                 drug_name       TEXT NOT NULL,
                 strength        TEXT,
                 form            TEXT,
                 labeler         TEXT,
                 qty_dispensed   REAL,
                 days_supply     REAL,
                 prescriber_name TEXT,
                 prescriber_dea  TEXT,
                 dispensed_at    TEXT NOT NULL,
                 dispensed_by    TEXT,
                 lot_number      TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_fill_history_patient ON fill_history(patient_id);
             CREATE INDEX IF NOT EXISTS idx_fill_history_rx ON fill_history(rx_id);

             PRAGMA user_version = 6;",
        )
        .map_err(|e| format!("Failed v6 migration (patients + fill_history): {}", e))?;
    }

    Ok(())
}

fn get_db() -> std::sync::MutexGuard<'static, Connection> {
    crate::app_db::get_conn()
}

fn get_active_session() -> std::sync::MutexGuard<'static, Option<ActiveSessionInfo>> {
    ACTIVE_SESSION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
}

// ─── Models ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSessionInfo {
    pub session_id: String,
    pub user_id: String,
    pub user_role: String,
    pub started_at: String,
    pub session_hash: String,
    pub last_event_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartResult {
    pub session_id: String,
    pub user_id: String,
    pub user_role: String,
    pub started_at: String,
    pub session_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainBreak {
    pub sequence: i64,
    pub event_id: String,
    pub break_type: String,
    pub expected: String,
    pub actual: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainVerification {
    pub valid: bool,
    pub total_checked: i64,
    pub broken_at: Option<ChainBreak>,
    pub verified_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prescription {
    pub id: String,
    pub rx_number: Option<String>,
    pub patient_id: String,
    pub status: String,
    pub schedule_class: Option<String>,
    pub eorder_data: Option<String>,
    pub tech_entry_data: Option<String>,
    pub rph_review_data: Option<String>,
    pub fill_data: Option<String>,
    pub rph_fill_review_data: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionResult {
    pub rx_id: String,
    pub old_status: String,
    pub new_status: String,
    pub rx_number: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    pub event_id: String,
    pub timestamp: String,
    pub monotonic_ns: i64,
    pub event_type: String,
    pub action: String,
    pub actor_id: String,
    pub actor_role: String,
    pub session_id: String,
    pub session_hash: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub rx_id: Option<String>,
    pub rx_number: Option<String>,
    pub patient_id: Option<String>,
    pub old_status: Option<String>,
    pub new_status: Option<String>,
    pub payload: Option<String>,
    pub sequence: i64,
    pub previous_hash: String,
    pub event_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EOrder {
    pub id: String,
    pub message_id: String,
    pub received_at: String,
    pub patient_id: Option<String>,
    pub status: String,
    pub raw_fields: String,   // JSON string — maps to MOCK_EORDERS[x].raw shape
    pub transcribed: String,  // JSON string — maps to MOCK_EORDERS[x].transcribed shape
    pub resolved_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prescriber {
    pub id: String,
    pub first_name: String,
    pub last_name: String,
    pub former_last_name: Option<String>,
    pub name_changed_at: Option<String>,
    pub credentials: Option<String>,
    pub dea: Option<String>,
    pub npi: Option<String>,
    pub practice: Option<String>,
    pub phone: Option<String>,
    pub fax: Option<String>,
    pub address: Option<String>,
    pub specialty: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FillHistoryEntry {
    pub id: String,
    pub patient_id: String,
    pub rx_id: String,
    pub rx_number: Option<String>,
    pub ndc: Option<String>,
    pub drug_name: String,
    pub strength: Option<String>,
    pub form: Option<String>,
    pub labeler: Option<String>,
    pub qty_dispensed: Option<f64>,
    pub days_supply: Option<f64>,
    pub prescriber_name: Option<String>,
    pub prescriber_dea: Option<String>,
    pub dispensed_at: String,
    pub dispensed_by: Option<String>,
    pub lot_number: Option<String>,
}

// ─── Hash helpers ─────────────────────────────────────────────────────

/// SHA-256 of "session_id|user_id|started_at".
fn compute_session_hash(session_id: &str, user_id: &str, started_at: &str) -> String {
    let input = format!("{}|{}|{}", session_id, user_id, started_at);
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    format!("{:x}", h.finalize())
}

/// SHA-256 of "session_hash|ended_at|last_event_hash".
fn compute_closing_hash(session_hash: &str, ended_at: &str, last_event_hash: &str) -> String {
    let input = format!("{}|{}|{}", session_hash, ended_at, last_event_hash);
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    format!("{:x}", h.finalize())
}

/// Canonical event hash — deterministic regardless of JSON key ordering.
/// Null fields are represented as empty string.
fn compute_event_hash(
    sequence: i64,
    event_id: &str,
    timestamp: &str,
    monotonic_ns: u64,
    event_type: &str,
    action: &str,
    actor_id: &str,
    actor_role: &str,
    session_id: &str,
    session_hash: &str,
    entity_type: &str,
    entity_id: &str,
    rx_id: &str,
    rx_number: &str,
    patient_id: &str,
    old_status: &str,
    new_status: &str,
    payload: &str,
    previous_hash: &str,
) -> String {
    let canonical = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        sequence, event_id, timestamp, monotonic_ns,
        event_type, action, actor_id, actor_role,
        session_id, session_hash,
        entity_type, entity_id, rx_id, rx_number, patient_id,
        old_status, new_status, payload,
        previous_hash
    );
    let mut h = Sha256::new();
    h.update(canonical.as_bytes());
    format!("{:x}", h.finalize())
}

// ─── Internal helpers ─────────────────────────────────────────────────

/// Maps action + current_status + actor_role to the new status.
fn validate_transition<'a>(
    current_status: &str,
    action: &str,
    actor_role: &str,
) -> Result<&'a str, String> {
    let is_tech = actor_role == "tech" || actor_role == "rph";
    let is_rph  = actor_role == "rph";

    match (current_status, action) {
        ("incoming",            "START_ENTRY")      if is_tech => Ok("in_entry"),
        ("in_entry",            "SUBMIT_RX")        if is_tech => Ok("pending_review"),
        ("pending_review",      "RPH_APPROVE")      if is_rph  => Ok("approved"),
        ("pending_review",      "RPH_RETURN")       if is_rph  => Ok("returned"),
        ("pending_review",      "RPH_CALL")         if is_rph  => Ok("call_prescriber"),
        ("returned",            "RESUBMIT_RX")      if is_tech => Ok("pending_review"),
        ("call_prescriber",     "RESOLVE_CALL")     if is_rph  => Ok("pending_review"),
        ("approved",            "START_FILL")       if is_tech => Ok("in_fill"),
        ("in_fill",             "SUBMIT_FILL")      if is_tech => Ok("pending_fill_verify"),
        ("pending_fill_verify", "RPH_VERIFY_FILL")  if is_rph  => Ok("ready"),
        ("pending_fill_verify", "RPH_REJECT_FILL")  if is_rph  => Ok("in_fill"),
        ("ready",               "SELL_RX")          if is_tech => Ok("sold"),
        _ => Err(format!(
            "Invalid transition: status='{}' action='{}' role='{}'",
            current_status, action, actor_role
        )),
    }
}

fn action_to_event_type(action: &str) -> &str {
    match action {
        "START_ENTRY"      => "rx:entry_started",
        "SUBMIT_RX"        => "rx:submitted",
        "RPH_APPROVE"      => "rx:approved",
        "RPH_RETURN"       => "rx:returned",
        "RPH_CALL"         => "rx:call_prescriber",
        "RESUBMIT_RX"      => "rx:resubmitted",
        "RESOLVE_CALL"     => "rx:call_resolved",
        "START_FILL"       => "rx:fill_started",
        "SUBMIT_FILL"      => "rx:fill_submitted",
        "RPH_VERIFY_FILL"  => "rx:fill_verified",
        "RPH_REJECT_FILL"  => "rx:fill_rejected",
        "SELL_RX"          => "rx:sold",
        _                  => "rx:unknown",
    }
}

fn schedule_to_class(schedule: &str) -> &str {
    match schedule {
        "C-II"  => "c2",
        "C-III" | "C-IV" | "C-V" => "c3-5",
        _ => "general",
    }
}

fn mint_rx_number(conn: &Connection, schedule_class: &str) -> Result<String, String> {
    let prefix: i64 = match schedule_class {
        "c2"   => 2,
        "c3-5" => 3,
        _      => 7,
    };

    let next: i64 = conn
        .query_row(
            "SELECT next_number FROM rx_counters WHERE schedule_prefix = ?",
            [prefix],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to read rx counter: {}", e))?;

    conn.execute(
        "UPDATE rx_counters SET next_number = next_number + 1 WHERE schedule_prefix = ?",
        [prefix],
    )
    .map_err(|e| format!("Failed to increment rx counter: {}", e))?;

    Ok(format!("{}{:05}", prefix, next))
}

/// Append one row to the Merkle-chained audit log.
/// Reads active session from the ACTIVE_SESSION global — never requires
/// the frontend to pass session credentials on individual commands.
/// Returns the computed event_hash (needed by end_session for closing_hash).
fn log_event(
    conn: &Connection,
    event_type: &str,
    action: &str,
    actor_id: &str,
    actor_role: &str,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    rx_id: Option<&str>,
    rx_number: Option<&str>,
    patient_id: Option<&str>,
    old_status: Option<&str>,
    new_status: Option<&str>,
    payload: Option<&str>,
) -> Result<String, String> {
    // Clone session info and release the lock before any DB work.
    let (session_id, session_hash) = {
        let guard = get_active_session();
        match guard.as_ref() {
            Some(s) => (s.session_id.clone(), s.session_hash.clone()),
            None => (
                "system".to_string(),
                "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            ),
        }
    };

    // Get the chain tail.
    let genesis = "0000000000000000000000000000000000000000000000000000000000000000";
    let (prev_hash, prev_seq) = conn
        .query_row(
            "SELECT event_hash, sequence FROM event_log ORDER BY sequence DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .unwrap_or_else(|_| (genesis.to_string(), 0));

    let sequence    = prev_seq + 1;
    let event_id    = format!("evt-{}", Uuid::new_v4());
    let timestamp   = crate::sys_clock::now();
    let monotonic   = crate::sys_clock::monotonic_ns();

    // Map Option<&str> to &str for hashing (None → "").
    let et  = entity_type.unwrap_or("");
    let ei  = entity_id.unwrap_or("");
    let ri  = rx_id.unwrap_or("");
    let rn  = rx_number.unwrap_or("");
    let pi  = patient_id.unwrap_or("");
    let os  = old_status.unwrap_or("");
    let ns  = new_status.unwrap_or("");
    let pay = payload.unwrap_or("");

    let event_hash = compute_event_hash(
        sequence, &event_id, &timestamp, monotonic,
        event_type, action, actor_id, actor_role,
        &session_id, &session_hash,
        et, ei, ri, rn, pi, os, ns, pay,
        &prev_hash,
    );

    conn.execute(
        "INSERT INTO event_log (
             event_id, timestamp, monotonic_ns,
             event_type, action, actor_id, actor_role,
             session_id, session_hash,
             entity_type, entity_id, rx_id, rx_number, patient_id,
             old_status, new_status, payload,
             sequence, previous_hash, event_hash
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![
            event_id, timestamp, monotonic as i64,
            event_type, action, actor_id, actor_role,
            session_id, session_hash,
            entity_type, entity_id, rx_id, rx_number, patient_id,
            old_status, new_status, payload,
            sequence, prev_hash, event_hash
        ],
    )
    .map_err(|e| format!("Failed to write event log: {}", e))?;

    // Update last_event_hash on the active session for closing_hash computation.
    {
        let mut guard = get_active_session();
        if let Some(ref mut s) = *guard {
            if s.session_id == session_id {
                s.last_event_hash = Some(event_hash.clone());
            }
        }
    }

    Ok(event_hash)
}

fn read_prescription(conn: &Connection, rx_id: &str) -> Result<Prescription, String> {
    conn.query_row(
        "SELECT id, rx_number, patient_id, status, schedule_class,
                eorder_data, tech_entry_data, rph_review_data,
                fill_data, rph_fill_review_data, created_at, updated_at
         FROM prescriptions WHERE id = ?",
        [rx_id],
        row_to_prescription,
    )
    .map_err(|e| format!("Failed to read prescription: {}", e))
}

fn row_to_prescription(row: &rusqlite::Row<'_>) -> rusqlite::Result<Prescription> {
    Ok(Prescription {
        id:                   row.get(0)?,
        rx_number:            row.get(1)?,
        patient_id:           row.get(2)?,
        status:               row.get(3)?,
        schedule_class:       row.get(4)?,
        eorder_data:          row.get(5)?,
        tech_entry_data:      row.get(6)?,
        rph_review_data:      row.get(7)?,
        fill_data:            row.get(8)?,
        rph_fill_review_data: row.get(9)?,
        created_at:           row.get(10)?,
        updated_at:           row.get(11)?,
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        id:            row.get(0)?,
        event_id:      row.get(1)?,
        timestamp:     row.get(2)?,
        monotonic_ns:  row.get(3)?,
        event_type:    row.get(4)?,
        action:        row.get(5)?,
        actor_id:      row.get(6)?,
        actor_role:    row.get(7)?,
        session_id:    row.get(8)?,
        session_hash:  row.get(9)?,
        entity_type:   row.get(10)?,
        entity_id:     row.get(11)?,
        rx_id:         row.get(12)?,
        rx_number:     row.get(13)?,
        patient_id:    row.get(14)?,
        old_status:    row.get(15)?,
        new_status:    row.get(16)?,
        payload:       row.get(17)?,
        sequence:      row.get(18)?,
        previous_hash: row.get(19)?,
        event_hash:    row.get(20)?,
    })
}

// ─── Session commands ─────────────────────────────────────────────────

/// Called when a user selects their identity at the login screen.
/// Creates a session record, sets the ACTIVE_SESSION global, logs session:started.
#[tauri::command]
pub fn start_session(user_id: String, user_role: String) -> Result<SessionStartResult, String> {
    let conn = get_db();

    // If there's already an active session (e.g. crash recovery), close it first.
    {
        let mut guard = get_active_session();
        if let Some(ref existing) = *guard {
            let ended_at = crate::sys_clock::now();
            let last = existing.last_event_hash.as_deref().unwrap_or(&existing.session_hash);
            let closing_hash = compute_closing_hash(&existing.session_hash, &ended_at, last);
            let _ = conn.execute(
                "UPDATE sessions SET ended_at = ?1, closing_hash = ?2 WHERE id = ?3",
                params![ended_at, closing_hash, existing.session_id],
            );
            *guard = None;
        }
    }

    let session_id  = format!("sess-{}", Uuid::new_v4());
    let started_at  = crate::sys_clock::now();
    let session_hash = compute_session_hash(&session_id, &user_id, &started_at);

    conn.execute(
        "INSERT INTO sessions (id, user_id, user_role, started_at, session_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session_id, user_id, user_role, started_at, session_hash],
    )
    .map_err(|e| format!("Failed to create session: {}", e))?;

    // Set ACTIVE_SESSION before calling log_event so it picks up the right session.
    {
        let mut guard = get_active_session();
        *guard = Some(ActiveSessionInfo {
            session_id:      session_id.clone(),
            user_id:         user_id.clone(),
            user_role:       user_role.clone(),
            started_at:      started_at.clone(),
            session_hash:    session_hash.clone(),
            last_event_hash: None,
        });
    }

    log_event(
        &conn,
        "session:started", "LOGIN",
        &user_id, &user_role,
        None, None, None, None, None, None, None,
        Some(&format!("{{\"sessionId\":\"{}\"}}", session_id)),
    )?;

    Ok(SessionStartResult { session_id, user_id, user_role, started_at, session_hash })
}

/// Called when a user clicks "switch user". Logs session:ended, seals the session
/// with a closing hash, and clears the ACTIVE_SESSION global.
#[tauri::command]
pub fn end_session() -> Result<(), String> {
    let conn = get_db();

    // Check there's a session to end.
    let session_exists = get_active_session().is_some();
    if !session_exists {
        return Ok(());
    }

    // Read what we need, release the lock.
    let (session_id, user_id, user_role) = {
        let guard = get_active_session();
        let s = guard.as_ref().unwrap();
        (s.session_id.clone(), s.user_id.clone(), s.user_role.clone())
    };

    // Log while session is still active — this updates last_event_hash.
    log_event(
        &conn,
        "session:ended", "LOGOUT",
        &user_id, &user_role,
        None, None, None, None, None, None, None,
        Some(&format!("{{\"sessionId\":\"{}\"}}", session_id)),
    )?;

    // Take the session out and compute the closing hash.
    let (session_hash, last_event_hash) = {
        let mut guard = get_active_session();
        let s = guard.take().unwrap();
        let last = s.last_event_hash.unwrap_or(s.session_hash.clone());
        (s.session_hash, last)
    };

    let ended_at     = crate::sys_clock::now();
    let closing_hash = compute_closing_hash(&session_hash, &ended_at, &last_event_hash);

    conn.execute(
        "UPDATE sessions SET ended_at = ?1, closing_hash = ?2 WHERE id = ?3",
        params![ended_at, closing_hash, session_id],
    )
    .map_err(|e| format!("Failed to close session: {}", e))?;

    Ok(())
}

// ─── Chain verification ───────────────────────────────────────────────

/// Walks the event_log in sequence order, recomputing each hash and verifying
/// the chain. Returns the first break found, or {valid: true} if intact.
#[tauri::command]
pub fn verify_audit_chain(
    start_seq: Option<i64>,
    end_seq: Option<i64>,
) -> Result<ChainVerification, String> {
    let conn = get_db();

    let start = start_seq.unwrap_or(1);
    let end   = end_seq.unwrap_or(i64::MAX);

    let genesis = "0000000000000000000000000000000000000000000000000000000000000000";

    // The expected previous_hash for the first event in our range.
    let mut expected_prev = if start <= 1 {
        genesis.to_string()
    } else {
        conn.query_row(
            "SELECT event_hash FROM event_log WHERE sequence = ?1",
            [start - 1],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("Failed to fetch pre-range hash: {}", e))?
    };

    let mut stmt = conn
        .prepare(
            "SELECT sequence, event_id, timestamp, monotonic_ns,
                    event_type, action, actor_id, actor_role,
                    session_id, session_hash,
                    entity_type, entity_id, rx_id, rx_number, patient_id,
                    old_status, new_status, payload,
                    previous_hash, event_hash
             FROM event_log
             WHERE sequence >= ?1 AND sequence <= ?2
             ORDER BY sequence ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![start, end], |row| {
            Ok((
                row.get::<_, i64>(0)?,          // sequence
                row.get::<_, String>(1)?,        // event_id
                row.get::<_, String>(2)?,        // timestamp
                row.get::<_, i64>(3)?,           // monotonic_ns
                row.get::<_, String>(4)?,        // event_type
                row.get::<_, String>(5)?,        // action
                row.get::<_, String>(6)?,        // actor_id
                row.get::<_, String>(7)?,        // actor_role
                row.get::<_, String>(8)?,        // session_id
                row.get::<_, String>(9)?,        // session_hash
                row.get::<_, Option<String>>(10)?, // entity_type
                row.get::<_, Option<String>>(11)?, // entity_id
                row.get::<_, Option<String>>(12)?, // rx_id
                row.get::<_, Option<String>>(13)?, // rx_number
                row.get::<_, Option<String>>(14)?, // patient_id
                row.get::<_, Option<String>>(15)?, // old_status
                row.get::<_, Option<String>>(16)?, // new_status
                row.get::<_, Option<String>>(17)?, // payload
                row.get::<_, String>(18)?,       // previous_hash
                row.get::<_, String>(19)?,       // event_hash
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut checked:  i64 = 0;
    let mut broken_at: Option<ChainBreak> = None;

    for row in rows {
        let (
            sequence, event_id, timestamp, monotonic_ns,
            event_type, action, actor_id, actor_role,
            session_id, session_hash,
            entity_type, entity_id, rx_id, rx_number, patient_id,
            old_status, new_status, payload,
            previous_hash, event_hash,
        ) = row.map_err(|e| e.to_string())?;

        checked += 1;

        // 1. Verify the chain link.
        if previous_hash != expected_prev {
            broken_at = Some(ChainBreak {
                sequence,
                event_id,
                break_type: "previous_hash_mismatch".to_string(),
                expected: expected_prev,
                actual: previous_hash,
            });
            break;
        }

        // 2. Recompute and verify the event hash.
        let recomputed = compute_event_hash(
            sequence, &event_id, &timestamp, monotonic_ns as u64,
            &event_type, &action, &actor_id, &actor_role,
            &session_id, &session_hash,
            entity_type.as_deref().unwrap_or(""),
            entity_id.as_deref().unwrap_or(""),
            rx_id.as_deref().unwrap_or(""),
            rx_number.as_deref().unwrap_or(""),
            patient_id.as_deref().unwrap_or(""),
            old_status.as_deref().unwrap_or(""),
            new_status.as_deref().unwrap_or(""),
            payload.as_deref().unwrap_or(""),
            &previous_hash,
        );

        if recomputed != event_hash {
            broken_at = Some(ChainBreak {
                sequence,
                event_id,
                break_type: "event_hash_mismatch".to_string(),
                expected: recomputed,
                actual: event_hash,
            });
            break;
        }

        expected_prev = event_hash;
    }

    Ok(ChainVerification {
        valid: broken_at.is_none(),
        total_checked: checked,
        broken_at,
        verified_at: crate::sys_clock::now(),
    })
}

// ─── Prescription commands ────────────────────────────────────────────

#[tauri::command]
pub fn create_prescription(
    patient_id: String,
    eorder_data: String,
    actor_id: String,
) -> Result<Prescription, String> {
    let conn = get_db();
    let id = Uuid::new_v4().to_string();

    // Read actor_role from active session; fall back to "tech".
    let actor_role = {
        let guard = get_active_session();
        guard.as_ref().map(|s| s.user_role.clone()).unwrap_or_else(|| "tech".to_string())
    };

    conn.execute(
        "INSERT INTO prescriptions (id, patient_id, status, eorder_data)
         VALUES (?1, ?2, 'incoming', ?3)",
        params![id, patient_id, eorder_data],
    )
    .map_err(|e| format!("Failed to create prescription: {}", e))?;

    log_event(
        &conn,
        "rx:created", "CREATE",
        &actor_id, &actor_role,
        Some("prescription"), Some(&id),
        Some(&id), None, Some(&patient_id),
        None, Some("incoming"),
        Some(&eorder_data),
    )?;

    read_prescription(&conn, &id)
}

/// Drive the prescription state machine.
#[tauri::command]
pub fn transition_rx(
    rx_id: String,
    action: String,
    actor_id: String,
    actor_role: String,
    payload: String,
) -> Result<TransitionResult, String> {
    let conn = get_db();

    let rx          = read_prescription(&conn, &rx_id)?;
    let old_status  = rx.status.clone();
    let new_status  = validate_transition(&old_status, &action, &actor_role)?;

    // Mint Rx number on RPH_APPROVE.
    let rx_number: Option<String> = if action == "RPH_APPROVE" {
        let schedule_class = extract_schedule_class_from_payload(&payload)
            .or_else(|| rx.schedule_class.clone())
            .unwrap_or_else(|| "general".to_string());
        Some(mint_rx_number(&conn, &schedule_class)?)
    } else {
        rx.rx_number.clone()
    };

    // Determine which data column to update.
    let payload_col = match action.as_str() {
        "SUBMIT_RX" | "RESUBMIT_RX"                              => "tech_entry_data",
        "RPH_APPROVE" | "RPH_RETURN" | "RPH_CALL" | "RESOLVE_CALL" => "rph_review_data",
        "SUBMIT_FILL"                                             => "fill_data",
        "RPH_VERIFY_FILL" | "RPH_REJECT_FILL"                    => "rph_fill_review_data",
        _ => "",
    };

    if !payload_col.is_empty() {
        let sql = format!(
            "UPDATE prescriptions SET status = ?1, rx_number = COALESCE(?2, rx_number),
             {} = ?3, updated_at = ?4 WHERE id = ?5",
            payload_col
        );
        conn.execute(
            &sql,
            params![new_status, rx_number, payload, crate::sys_clock::now(), rx_id],
        )
        .map_err(|e| format!("Failed to update prescription: {}", e))?;
    } else {
        conn.execute(
            "UPDATE prescriptions SET status = ?1, rx_number = COALESCE(?2, rx_number),
             updated_at = ?3 WHERE id = ?4",
            params![new_status, rx_number, crate::sys_clock::now(), rx_id],
        )
        .map_err(|e| format!("Failed to update prescription: {}", e))?;
    }

    // Update schedule_class so it's available at approval time.
    if action == "SUBMIT_RX" || action == "RESUBMIT_RX" {
        if let Some(sc) = extract_schedule_class_from_payload(&payload) {
            conn.execute(
                "UPDATE prescriptions SET schedule_class = ?1 WHERE id = ?2",
                params![sc, rx_id],
            )
            .map_err(|e| format!("Failed to update schedule_class: {}", e))?;
        }
    }

    let event_type = action_to_event_type(&action);
    log_event(
        &conn,
        event_type, &action,
        &actor_id, &actor_role,
        Some("prescription"), Some(&rx_id),
        Some(&rx_id), rx_number.as_deref(), Some(&rx.patient_id),
        Some(&old_status), Some(new_status),
        Some(&payload),
    )?;

    let timestamp: String = conn
        .query_row(
            "SELECT updated_at FROM prescriptions WHERE id = ?",
            [&rx_id],
            |row| row.get(0),
        )
        .unwrap_or_default();

    Ok(TransitionResult {
        rx_id,
        old_status,
        new_status: new_status.to_string(),
        rx_number,
        timestamp,
    })
}

fn extract_schedule_class_from_payload(payload: &str) -> Option<String> {
    if payload.is_empty() || payload == "{}" {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
        if let Some(sc) = v.get("scheduleClass").and_then(|x| x.as_str()) {
            return Some(sc.to_string());
        }
        if let Some(schedule) = v.get("schedule").and_then(|x| x.as_str()) {
            return Some(schedule_to_class(schedule).to_string());
        }
    }
    None
}

// ─── Query commands ───────────────────────────────────────────────────

#[tauri::command]
pub fn get_prescription(rx_id: String) -> Result<Option<Prescription>, String> {
    let conn = get_db();
    conn.query_row(
        "SELECT id, rx_number, patient_id, status, schedule_class,
                eorder_data, tech_entry_data, rph_review_data,
                fill_data, rph_fill_review_data, created_at, updated_at
         FROM prescriptions WHERE id = ?",
        [&rx_id],
        row_to_prescription,
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_prescriptions_by_patient(patient_id: String) -> Result<Vec<Prescription>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, rx_number, patient_id, status, schedule_class,
                    eorder_data, tech_entry_data, rph_review_data,
                    fill_data, rph_fill_review_data, created_at, updated_at
             FROM prescriptions WHERE patient_id = ?
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_map([&patient_id], row_to_prescription)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub fn get_prescriptions_by_status(status: String) -> Result<Vec<Prescription>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, rx_number, patient_id, status, schedule_class,
                    eorder_data, tech_entry_data, rph_review_data,
                    fill_data, rph_fill_review_data, created_at, updated_at
             FROM prescriptions WHERE status = ?
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_map([&status], row_to_prescription)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub fn get_active_prescriptions() -> Result<Vec<Prescription>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, rx_number, patient_id, status, schedule_class,
                    eorder_data, tech_entry_data, rph_review_data,
                    fill_data, rph_fill_review_data, created_at, updated_at
             FROM prescriptions WHERE status NOT IN ('ready', 'sold')
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_map([], row_to_prescription)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub fn get_all_prescriptions() -> Result<Vec<Prescription>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, rx_number, patient_id, status, schedule_class,
                    eorder_data, tech_entry_data, rph_review_data,
                    fill_data, rph_fill_review_data, created_at, updated_at
             FROM prescriptions
             WHERE rx_number IS NOT NULL
             ORDER BY CAST(rx_number AS INTEGER) ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_map([], row_to_prescription)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub fn get_queue_counts() -> Result<HashMap<String, i32>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM prescriptions GROUP BY status")
        .map_err(|e| e.to_string())?;

    let mut counts: HashMap<String, i32> = HashMap::new();
    for row in stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (status, count) = row.map_err(|e| e.to_string())?;
        counts.insert(status, count);
    }
    Ok(counts)
}

#[tauri::command]
pub fn get_events_by_rx(rx_id: String) -> Result<Vec<Event>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, event_id, timestamp, monotonic_ns,
                    event_type, action, actor_id, actor_role,
                    session_id, session_hash,
                    entity_type, entity_id, rx_id, rx_number, patient_id,
                    old_status, new_status, payload,
                    sequence, previous_hash, event_hash
             FROM event_log WHERE rx_id = ?
             ORDER BY sequence ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_map([&rx_id], row_to_event)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub fn get_events_by_date_range(start: String, end: String) -> Result<Vec<Event>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, event_id, timestamp, monotonic_ns,
                    event_type, action, actor_id, actor_role,
                    session_id, session_hash,
                    entity_type, entity_id, rx_id, rx_number, patient_id,
                    old_status, new_status, payload,
                    sequence, previous_hash, event_hash
             FROM event_log WHERE timestamp BETWEEN ?1 AND ?2
             ORDER BY sequence ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_map(params![start, end], row_to_event)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

// ─── User commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn get_users() -> Result<Vec<User>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare("SELECT id, name, role FROM users ORDER BY role DESC, name ASC")
        .map_err(|e| e.to_string())?;

    let result = stmt.query_map([], |row| {
        Ok(User {
            id:   row.get(0)?,
            name: row.get(1)?,
            role: row.get(2)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string());
    result
}

// ─── E-Order commands ─────────────────────────────────────────────────

/// Return the text content of the first element with the given local name
/// that is a descendant of `node`. Namespace-agnostic.
fn xml_find_text(node: roxmltree::Node, name: &str) -> String {
    node.descendants()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

/// Scoped search: first find `ancestor`, then find `name` within it.
fn xml_scoped_text(root: roxmltree::Node, ancestor: &str, name: &str) -> String {
    root.descendants()
        .find(|n| n.is_element() && n.tag_name().name() == ancestor)
        .map(|parent| xml_find_text(parent, name))
        .unwrap_or_default()
}

/// Format an 11-digit NDC (no separators) to the 5-4-2 dashed form.
/// "00069153030" → "00069-1530-30". Passes through if already formatted.
fn format_ndc(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() == 11 {
        format!("{}-{}-{}", &digits[0..5], &digits[5..9], &digits[9..11])
    } else {
        raw.to_string()
    }
}

/// Parse an NCPDP SCRIPT XML string into a flat raw_fields JSON and a
/// human-readable transcribed JSON. Returns (message_id, raw_fields, transcribed).
///
/// Supports NCPDP SCRIPT 10.6 / 2017071 NewRx messages. The parser is
/// namespace-agnostic and extracts fields by local element name so it
/// works with any NCPDP namespace URL.
pub fn parse_ncpdp_xml(xml: &str) -> Result<(String, String, String), String> {
    let doc = Document::parse(xml).map_err(|e| format!("XML parse error: {}", e))?;
    let root = doc.root_element();

    // ── Header ────────────────────────────────────────────────────────
    let message_id   = xml_find_text(root, "MessageID");
    let sent_time    = xml_find_text(root, "SentTime");
    let from_npi     = xml_find_text(root, "From");

    // Detect message type from the body child element (NewRx, Refill, etc.)
    let message_type = root.descendants()
        .find(|n| {
            n.is_element() && matches!(
                n.tag_name().name(),
                "NewRx" | "Refill" | "ChangeRequest" | "CancelRx" |
                "RxFill" | "RxHistoryRequest" | "Error"
            )
        })
        .map(|n| n.tag_name().name().to_uppercase())
        .unwrap_or_else(|| "NEWRX".to_string());

    // ── Patient ───────────────────────────────────────────────────────
    let patient_last    = xml_scoped_text(root, "HumanPatient", "LastName");
    let patient_first   = xml_scoped_text(root, "HumanPatient", "FirstName");
    let patient_dob_raw = xml_scoped_text(root, "DateOfBirth", "Date");

    // ── Prescriber ────────────────────────────────────────────────────
    let (prescriber_last, prescriber_first, prescriber_dea, prescriber_npi,
         prescriber_phone, prescriber_addr) = {
        if let Some(ps) = root.descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "NonVeterinarian")
        {
            let last  = xml_find_text(ps, "LastName");
            let first = xml_find_text(ps, "FirstName");
            let dea   = xml_find_text(ps, "DEANumber");
            let npi_ident = xml_scoped_text(ps, "Identification", "NPI");
            let npi   = if npi_ident.is_empty() { from_npi.clone() } else { npi_ident };
            let phone = xml_scoped_text(ps, "PrimaryTelephone", "Number");
            let line  = xml_find_text(ps, "AddressLine1");
            let city  = xml_find_text(ps, "City");
            let state = xml_find_text(ps, "StateProvince");
            let zip   = xml_find_text(ps, "PostalCode");
            let addr  = if line.is_empty() {
                String::new()
            } else {
                format!("{}, {} {} {}", line, city, state, zip)
            };
            (last, first, dea, npi, phone, addr)
        } else {
            (String::new(), String::new(), String::new(),
             from_npi.clone(), String::new(), String::new())
        }
    };

    // ── Medication ────────────────────────────────────────────────────
    let drug_desc    = xml_find_text(root, "DrugDescription");
    let drug_coded   = xml_find_text(root, "DrugDBCode");  // generic name

    // NDC: find ProductCode with Qualifier="ND" (or first ProductCode)
    let drug_ndc = {
        let mut ndc = String::new();
        for pc in root.descendants().filter(|n| n.is_element() && n.tag_name().name() == "ProductCode") {
            let q = xml_find_text(pc, "Qualifier");
            if q == "ND" || q.is_empty() {
                let code = xml_find_text(pc, "Code");
                if !code.is_empty() {
                    ndc = format_ndc(&code);
                    break;
                }
            }
        }
        ndc
    };

    let drug_strength_val  = xml_find_text(root, "StrengthValue");
    let drug_strength_unit = xml_find_text(root, "StrengthUnitOfMeasure");
    let drug_strength = if drug_strength_val.is_empty() {
        String::new()
    } else if drug_strength_unit.is_empty() {
        drug_strength_val.clone()
    } else {
        format!("{} {}", drug_strength_val, drug_strength_unit)
    };
    let drug_form = xml_find_text(root, "DosageForm");
    let drug_qty  = xml_scoped_text(root, "Quantity", "Value");
    let drug_days = xml_find_text(root, "DaysSupply");
    let refills   = xml_scoped_text(root, "Refills", "Value");
    let subst_code = xml_find_text(root, "SubstitutionCode");
    let sig_text  = xml_find_text(root, "SigText");
    let sig_code  = xml_scoped_text(root, "Sig", "Sig");
    let date_written = {
        let d = xml_scoped_text(root, "WrittenDate", "Date");
        if d.is_empty() { xml_find_text(root, "WrittenDate") } else { d }
    };
    let note = xml_find_text(root, "Note");

    // ── Build raw_fields JSON ─────────────────────────────────────────
    let raw = serde_json::json!({
        "messageType":       message_type,
        "drugDescription":   drug_desc,
        "drugNDC":           drug_ndc,
        "drugCodedName":     drug_coded,
        "drugStrength":      drug_strength,
        "drugForm":          drug_form,
        "drugQuantity":      drug_qty,
        "drugDaysSupply":    drug_days,
        "refillsAuthorized": refills,
        "substitutionCode":  subst_code,
        "sigText":           sig_text,
        "sigCode":           sig_code,
        "prescriberLastName":  prescriber_last,
        "prescriberFirstName": prescriber_first,
        "prescriberDEA":     prescriber_dea,
        "prescriberNPI":     prescriber_npi,
        "prescriberPhone":   prescriber_phone,
        "prescriberAddress": prescriber_addr,
        "patientLastName":   patient_last,
        "patientFirstName":  patient_first,
        "patientDOB":        patient_dob_raw,
        "dateWritten":       date_written,
        "note":              note,
    });

    // ── Build transcribed JSON ────────────────────────────────────────
    let drug_display = if drug_desc.is_empty() {
        format!("{} {}", drug_coded, drug_strength)
    } else {
        drug_desc.clone()
    };

    // Format YYYYMMDD → MM/DD/YYYY
    let fmt_date = |ymd: &str| -> String {
        if ymd.len() == 8 {
            format!("{}/{}/{}", &ymd[4..6], &ymd[6..8], &ymd[0..4])
        } else {
            ymd.to_string()
        }
    };

    let prescriber_display = if prescriber_last.is_empty() {
        String::new()
    } else {
        format!("Dr. {} {}", prescriber_first, prescriber_last)
    };

    let qty_num: u32   = drug_qty.parse().unwrap_or(0);
    let days_num: u32  = drug_days.parse().unwrap_or(0);
    let refills_num: u32 = refills.parse().unwrap_or(0);
    let daw_num: u32   = subst_code.parse().unwrap_or(0);

    // Convert sigText to title-case for readability
    let sig_display = {
        let s = sig_text.to_lowercase();
        let mut c = s.chars();
        match c.next() {
            None => String::new(),
            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        }
    };

    let trans = serde_json::json!({
        "drug":         drug_display,
        "sig":          sig_display,
        "qty":          qty_num,
        "daySupply":    days_num,
        "refills":      refills_num,
        "daw":          daw_num,
        "prescriber":   prescriber_display,
        "prescriberDEA": prescriber_dea,
        "dateWritten":  fmt_date(&date_written),
        "patient":      format!("{} {}", patient_first, patient_last).trim().to_string(),
        "patientDOB":   fmt_date(&patient_dob_raw),
        "note":         note,
    });

    Ok((
        message_id,
        serde_json::to_string(&raw).unwrap_or_default(),
        serde_json::to_string(&trans).unwrap_or_default(),
    ))
}

fn row_to_eorder(row: &rusqlite::Row<'_>) -> rusqlite::Result<EOrder> {
    Ok(EOrder {
        id:          row.get(0)?,
        message_id:  row.get(1)?,
        received_at: row.get(2)?,
        patient_id:  row.get(3)?,
        status:      row.get(4)?,
        raw_fields:  row.get(5)?,
        transcribed: row.get(6)?,
        resolved_at: row.get(7)?,
    })
}

/// Ingest a raw NCPDP SCRIPT XML payload. Parses the XML, extracts fields,
/// and inserts a new pending eorder. The `patient_id` can be pre-matched
/// by the caller if the patient is already known.
///
/// Returns the created EOrder. If the MessageID already exists, returns an
/// error (idempotency guard — SureScripts may resend on timeout).
#[tauri::command]
pub fn ingest_eorder_xml(xml_payload: String, patient_id: Option<String>) -> Result<EOrder, String> {
    let conn = get_db();

    let (message_id, raw_fields, transcribed) = parse_ncpdp_xml(&xml_payload)?;

    if message_id.is_empty() {
        return Err("XML missing Header/MessageID".to_string());
    }

    let id          = format!("eo-{}", Uuid::new_v4());
    let received_at = crate::sys_clock::now();

    conn.execute(
        "INSERT INTO eorders (id, message_id, received_at, patient_id, status, raw_xml, raw_fields, transcribed)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7)",
        params![id, message_id, received_at, patient_id, xml_payload, raw_fields, transcribed],
    )
    .map_err(|e| format!("Failed to insert eorder: {}", e))?;

    let actor_role = {
        let g = get_active_session();
        g.as_ref().map(|s| s.user_role.clone()).unwrap_or_else(|| "system".to_string())
    };
    let actor_id = {
        let g = get_active_session();
        g.as_ref().map(|s| s.user_id.clone()).unwrap_or_else(|| "system".to_string())
    };

    log_event(
        &conn,
        "eorder:received", "INGEST_XML",
        &actor_id, &actor_role,
        Some("eorder"), Some(&id),
        None, None, patient_id.as_deref(),
        None, Some("pending"),
        Some(&format!("{{\"messageId\":\"{}\"}}", message_id)),
    )?;

    conn.query_row(
        "SELECT id, message_id, received_at, patient_id, status, raw_fields, transcribed, resolved_at
         FROM eorders WHERE id = ?",
        [&id],
        row_to_eorder,
    )
    .map_err(|e| e.to_string())
}

/// Return all pending eorders, ordered oldest-first (FIFO queue).
#[tauri::command]
pub fn get_all_eorders() -> Result<Vec<EOrder>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, message_id, received_at, patient_id, status, raw_fields, transcribed, resolved_at
             FROM eorders WHERE status = 'pending'
             ORDER BY received_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt
        .query_map([], row_to_eorder)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

/// Return the pending eorder linked to a specific patient.
#[tauri::command]
pub fn get_eorder_by_patient(patient_id: String) -> Result<Option<EOrder>, String> {
    let conn = get_db();
    // Return the most recent eorder for this patient regardless of status —
    // the eorder is needed as a reference document throughout the workflow,
    // even after it has been resolved/submitted.
    conn.query_row(
        "SELECT id, message_id, received_at, patient_id, status, raw_fields, transcribed, resolved_at
         FROM eorders WHERE patient_id = ?
         ORDER BY received_at DESC LIMIT 1",
        [&patient_id],
        row_to_eorder,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Mark an eorder as resolved. Called when a tech opens the eorder for
/// data entry, so it clears from the incoming queue.
#[tauri::command]
pub fn mark_eorder_resolved(id: String) -> Result<(), String> {
    let conn = get_db();

    let resolved_at = crate::sys_clock::now();
    conn.execute(
        "UPDATE eorders SET status = 'resolved', resolved_at = ?1 WHERE id = ?2",
        params![resolved_at, id],
    )
    .map_err(|e| format!("Failed to resolve eorder: {}", e))?;

    let actor_role = {
        let g = get_active_session();
        g.as_ref().map(|s| s.user_role.clone()).unwrap_or_else(|| "tech".to_string())
    };
    let actor_id = {
        let g = get_active_session();
        g.as_ref().map(|s| s.user_id.clone()).unwrap_or_else(|| "system".to_string())
    };

    log_event(
        &conn,
        "eorder:resolved", "RESOLVE",
        &actor_id, &actor_role,
        Some("eorder"), Some(&id),
        None, None, None,
        Some("pending"), Some("resolved"),
        None,
    )?;

    Ok(())
}

// ─── Prescriber Commands ───────────────────────────────────────────────

fn row_to_prescriber(row: &rusqlite::Row) -> rusqlite::Result<Prescriber> {
    Ok(Prescriber {
        id:               row.get(0)?,
        first_name:       row.get(1)?,
        last_name:        row.get(2)?,
        former_last_name: row.get(3)?,
        name_changed_at:  row.get(4)?,
        credentials:      row.get(5)?,
        dea:              row.get(6)?,
        npi:              row.get(7)?,
        practice:         row.get(8)?,
        phone:            row.get(9)?,
        fax:              row.get(10)?,
        address:          row.get(11)?,
        specialty:        row.get(12)?,
        notes:            row.get(13)?,
        created_at:       row.get(14)?,
        updated_at:       row.get(15)?,
    })
}

/// Return all prescribers, sorted by last name.
#[tauri::command]
pub fn get_all_prescribers() -> Result<Vec<Prescriber>, String> {
    let conn = get_db();
    let mut stmt = conn.prepare(
        "SELECT id, first_name, last_name, former_last_name, name_changed_at,
                credentials, dea, npi, practice, phone, fax, address, specialty, notes,
                created_at, updated_at
         FROM prescribers ORDER BY last_name, first_name",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], row_to_prescriber).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Return a single prescriber by id.
#[tauri::command]
pub fn get_prescriber(id: String) -> Result<Option<Prescriber>, String> {
    let conn = get_db();
    conn.query_row(
        "SELECT id, first_name, last_name, former_last_name, name_changed_at,
                credentials, dea, npi, practice, phone, fax, address, specialty, notes,
                created_at, updated_at
         FROM prescribers WHERE id = ?",
        [&id],
        row_to_prescriber,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Full-text search across name, DEA, NPI, and practice. Returns up to 20 results.
#[tauri::command]
pub fn search_prescribers_db(query: String) -> Result<Vec<Prescriber>, String> {
    let conn = get_db();
    let pattern = format!("%{}%", query.to_lowercase());
    let mut stmt = conn.prepare(
        "SELECT id, first_name, last_name, former_last_name, name_changed_at,
                credentials, dea, npi, practice, phone, fax, address, specialty, notes,
                created_at, updated_at
         FROM prescribers
         WHERE lower(first_name)       LIKE ?1
            OR lower(last_name)        LIKE ?1
            OR lower(former_last_name) LIKE ?1
            OR lower(practice)         LIKE ?1
            OR lower(dea)              LIKE ?1
            OR lower(npi)              LIKE ?1
         ORDER BY last_name, first_name
         LIMIT 20",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([&pattern], row_to_prescriber).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Create or update a prescriber. Automatically tracks last-name changes:
/// if the last name differs from the stored value and no former_last_name
/// is already on record, the old last name is saved as former_last_name.
#[tauri::command]
pub fn upsert_prescriber(prescriber: serde_json::Value) -> Result<Prescriber, String> {
    let conn = get_db();

    let id = prescriber["id"].as_str().ok_or("prescriber.id required")?.to_string();
    let first_name  = prescriber["firstName"].as_str().unwrap_or("").to_string();
    let new_last    = prescriber["lastName"].as_str().unwrap_or("").to_string();
    let credentials = prescriber["credentials"].as_str().map(str::to_string);
    let dea         = prescriber["dea"].as_str().map(str::to_string);
    let npi         = prescriber["npi"].as_str().map(str::to_string);
    let practice    = prescriber["practice"].as_str().map(str::to_string);
    let phone       = prescriber["phone"].as_str().map(str::to_string);
    let fax         = prescriber["fax"].as_str().map(str::to_string);
    let address     = prescriber["address"].as_str().map(str::to_string);
    let specialty   = prescriber["specialty"].as_str().map(str::to_string);
    let notes_val   = prescriber["notes"].as_str().map(str::to_string);
    // Caller may explicitly supply formerLastName (e.g., manually set by user).
    let caller_former = prescriber["formerLastName"].as_str().map(str::to_string);

    let now = crate::sys_clock::now();

    // Detect name change: if row exists, compare last names.
    let existing = conn.query_row(
        "SELECT last_name, former_last_name FROM prescribers WHERE id = ?",
        [&id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    ).optional().map_err(|e| e.to_string())?;

    let (former_last_name, name_changed_at) = match existing {
        Some((old_last, old_former)) => {
            // If caller explicitly supplies formerLastName, respect it.
            if let Some(ref clf) = caller_former {
                (Some(clf.clone()), prescriber["nameChangedAt"].as_str().map(str::to_string))
            } else if old_last != new_last && old_former.is_none() {
                // Auto-detect: last name changed and no prior alias recorded.
                (Some(old_last), Some(now.clone()))
            } else {
                (old_former, None) // preserve existing value, no update needed
            }
        }
        None => (caller_former, None), // new row — use whatever caller supplied
    };

    conn.execute(
        "INSERT INTO prescribers
             (id, first_name, last_name, former_last_name, name_changed_at,
              credentials, dea, npi, practice, phone, fax, address, specialty, notes,
              created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,
                 COALESCE((SELECT created_at FROM prescribers WHERE id=?1), ?15),
                 ?15)
         ON CONFLICT(id) DO UPDATE SET
             first_name       = excluded.first_name,
             last_name        = excluded.last_name,
             former_last_name = excluded.former_last_name,
             name_changed_at  = COALESCE(excluded.name_changed_at, prescribers.name_changed_at),
             credentials      = excluded.credentials,
             dea              = excluded.dea,
             npi              = excluded.npi,
             practice         = excluded.practice,
             phone            = excluded.phone,
             fax              = excluded.fax,
             address          = excluded.address,
             specialty        = excluded.specialty,
             notes            = excluded.notes,
             updated_at       = excluded.updated_at",
        params![
            id, first_name, new_last, former_last_name, name_changed_at,
            credentials, dea, npi, practice, phone, fax, address, specialty, notes_val,
            now
        ],
    )
    .map_err(|e| format!("Failed to upsert prescriber: {}", e))?;

    // Return the saved record.
    conn.query_row(
        "SELECT id, first_name, last_name, former_last_name, name_changed_at,
                credentials, dea, npi, practice, phone, fax, address, specialty, notes,
                created_at, updated_at
         FROM prescribers WHERE id = ?",
        [&id],
        row_to_prescriber,
    )
    .map_err(|e| e.to_string())
}

// ─── Fill History ──────────────────────────────────────────────────────

#[tauri::command]
pub fn append_fill_history(entry: serde_json::Value) -> Result<FillHistoryEntry, String> {
    let conn = get_db();
    let id = entry["id"].as_str().unwrap_or("").to_string();
    conn.execute(
        "INSERT INTO fill_history
         (id, patient_id, rx_id, rx_number, ndc, drug_name, strength, form, labeler,
          qty_dispensed, days_supply, prescriber_name, prescriber_dea,
          dispensed_at, dispensed_by, lot_number)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            id,
            entry["patientId"].as_str().unwrap_or(""),
            entry["rxId"].as_str().unwrap_or(""),
            entry["rxNumber"].as_str(),
            entry["ndc"].as_str(),
            entry["drugName"].as_str().unwrap_or(""),
            entry["strength"].as_str(),
            entry["form"].as_str(),
            entry["labeler"].as_str(),
            entry["qtyDispensed"].as_f64(),
            entry["daysSupply"].as_f64(),
            entry["prescriberName"].as_str(),
            entry["prescriberDea"].as_str(),
            entry["dispensedAt"].as_str().unwrap_or(""),
            entry["dispensedBy"].as_str(),
            entry["lotNumber"].as_str(),
        ],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, patient_id, rx_id, rx_number, ndc, drug_name, strength, form,
                labeler, qty_dispensed, days_supply, prescriber_name, prescriber_dea,
                dispensed_at, dispensed_by, lot_number
         FROM fill_history WHERE id = ?1",
        params![id],
        |row| Ok(FillHistoryEntry {
            id: row.get(0)?, patient_id: row.get(1)?, rx_id: row.get(2)?,
            rx_number: row.get(3)?, ndc: row.get(4)?, drug_name: row.get(5)?,
            strength: row.get(6)?, form: row.get(7)?, labeler: row.get(8)?,
            qty_dispensed: row.get(9)?, days_supply: row.get(10)?,
            prescriber_name: row.get(11)?, prescriber_dea: row.get(12)?,
            dispensed_at: row.get(13)?, dispensed_by: row.get(14)?,
            lot_number: row.get(15)?,
        }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_fill_history(patient_id: String) -> Result<Vec<FillHistoryEntry>, String> {
    let conn = get_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, patient_id, rx_id, rx_number, ndc, drug_name, strength, form,
                    labeler, qty_dispensed, days_supply, prescriber_name, prescriber_dea,
                    dispensed_at, dispensed_by, lot_number
             FROM fill_history WHERE patient_id = ?1
             ORDER BY dispensed_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt
        .query_map(params![patient_id], |row| Ok(FillHistoryEntry {
            id: row.get(0)?, patient_id: row.get(1)?, rx_id: row.get(2)?,
            rx_number: row.get(3)?, ndc: row.get(4)?, drug_name: row.get(5)?,
            strength: row.get(6)?, form: row.get(7)?, labeler: row.get(8)?,
            qty_dispensed: row.get(9)?, days_supply: row.get(10)?,
            prescriber_name: row.get(11)?, prescriber_dea: row.get(12)?,
            dispensed_at: row.get(13)?, dispensed_by: row.get(14)?,
            lot_number: row.get(15)?,
        }))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}
