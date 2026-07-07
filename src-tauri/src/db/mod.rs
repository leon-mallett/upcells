pub mod models;

use rusqlite::{Connection, Result as SqlResult};
use std::path::Path;
use std::sync::{Arc, Mutex, Once};

pub type DbConnection = Arc<Mutex<Connection>>;

/// Ordered schema migrations. Each runs once, in order, when the DB is below its version.
/// Migration 001 creates `schema_migrations` itself (the version query falls back to 0).
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("migrations/001_initial.sql")),
    (2, include_str!("migrations/002_data_pools.sql")),
    (3, include_str!("migrations/003_knowledge.sql")),
];

/// Register the `sqlite-vec` extension so `vec0` virtual tables + vector functions are available
/// on every connection opened afterwards. Must run before opening the app connection (the
/// knowledge migration creates a `vec0` table). Idempotent.
pub fn register_vec_extension() {
    static VEC_INIT: Once = Once::new();
    VEC_INIT.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

pub fn open(data_dir: &Path) -> SqlResult<DbConnection> {
    register_vec_extension();
    std::fs::create_dir_all(data_dir).ok();
    let db_path = data_dir.join("upcells.db");
    let conn = Connection::open(&db_path)?;

    // Enable WAL mode and foreign keys
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    run_migrations(&conn)?;
    cleanup_interrupted_syncs(&conn)?;

    Ok(Arc::new(Mutex::new(conn)))
}

/// If the app crashed or was force-quit during a sync, its `sync_history`
/// row would be stuck at `status='running'` forever. We can safely assume
/// anything still marked as running at app startup didn't actually complete
/// — there's no way a sync from a previous process is still in flight.
fn cleanup_interrupted_syncs(conn: &Connection) -> SqlResult<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE sync_history
         SET status = 'interrupted',
             error_summary = COALESCE(error_summary,
                 'Interrupted — app closed before the sync finished'),
             completed_at = ?1
         WHERE status = 'running'",
        rusqlite::params![now],
    )?;
    Ok(())
}

fn run_migrations(conn: &Connection) -> SqlResult<()> {
    // Current schema version (0 before the first migration creates the tracking table).
    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    for (target, sql) in MIGRATIONS {
        if version < *target {
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![target, chrono::Utc::now().timestamp()],
            )?;
        }
    }

    Ok(())
}

/// Helper: get a config value from app_config table
pub fn get_config(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_config WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    )
    .ok()
}

/// Helper: set a config value in app_config table
pub fn set_config(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )?;
    Ok(())
}
