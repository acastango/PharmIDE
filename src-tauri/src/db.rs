use rusqlite::Connection;
use std::sync::Mutex;

static DB: std::sync::OnceLock<Mutex<Connection>> = std::sync::OnceLock::new();

pub fn init(path: &str) -> Result<(), String> {
    let conn = Connection::open(path)
        .map_err(|e| format!("Failed to open database: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    DB.set(Mutex::new(conn))
        .map_err(|_| "Database already initialized".to_string())?;

    Ok(())
}

pub fn get() -> std::sync::MutexGuard<'static, Connection> {
    DB.get()
        .expect("Database not initialized")
        .lock()
        .expect("Database mutex poisoned")
}
