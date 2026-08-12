use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

pub struct AppDb {
    // Used by upcoming DB commands; kept here so the scaffold compiles cleanly.
    #[allow(dead_code)]
    pub conn: Mutex<Connection>,
}

impl AppDb {
    pub fn open(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;

        let conn = Connection::open(dir.join("reader.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}
