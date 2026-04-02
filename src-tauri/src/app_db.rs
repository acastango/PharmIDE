use rusqlite::Connection;
use std::sync::{Mutex, MutexGuard, OnceLock};

static APP_DB: OnceLock<Mutex<Connection>> = OnceLock::new();

pub fn get_conn() -> MutexGuard<'static, Connection> {
    APP_DB.get().expect("app DB not initialised").lock().unwrap()
}

pub fn init(path: &str) -> Result<(), String> {
    let conn = Connection::open(path)
        .map_err(|e| format!("Failed to open app DB: {}", e))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    APP_DB
        .set(Mutex::new(conn))
        .map_err(|_| "app DB already initialised".to_string())
}
