use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

use crate::paths::now_ms;

pub struct AppDb {
    // Backing connection for all upcoming DB commands.
    #[allow(dead_code)]
    pub conn: Mutex<Connection>,
}

impl AppDb {
    pub fn open(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;

        let mut conn = Connection::open(dir.join("reader.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn, &dir)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

struct Migration {
    version: i64,
    name: &'static str,
    sql: Option<&'static str>,
    apply: Option<fn(&Connection, &Path) -> Result<(), Box<dyn std::error::Error>>>,
}

/// Every schema change is appended here as a new entry. Old versions upgrade
/// by replaying only the migrations they haven't seen yet.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        sql: Some(include_str!("../migrations/001_init.sql")),
        apply: None,
    },
    Migration {
        version: 2,
        name: "import_legacy",
        sql: None,
        apply: Some(crate::import::run),
    },
    Migration {
        version: 3,
        name: "tags",
        sql: Some(include_str!("../migrations/003_tags.sql")),
        apply: None,
    },
    Migration {
        version: 4,
        name: "tag_kind",
        sql: Some(include_str!("../migrations/004_tag_kind.sql")),
        apply: None,
    },
];

fn migrate(conn: &mut Connection, data_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // Bootstrap the version ledger itself; this is idempotent.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );",
    )?;

    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;

    for m in MIGRATIONS.iter().filter(|m| m.version > current) {
        let tx = conn.transaction()?;
        if let Some(sql) = m.sql {
            tx.execute_batch(sql)?;
        }
        if let Some(apply) = m.apply {
            apply(&tx, data_dir)?;
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![m.version, m.name, now_ms()],
        )?;
        tx.commit()?;
    }
    Ok(())
}
