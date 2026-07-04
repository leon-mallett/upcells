//! Query sandbox — defence in depth for running model-generated SQL (§1.5).
//!
//! Two independent layers:
//! 1. [`open_for_query`] — a hardened **read-only** DuckDB connection: no filesystem/network
//!    access, no extensions, and `lock_configuration` so SQL can't `SET` its way back out.
//! 2. [`is_safe_select`] — a statement allowlist (single read-only `SELECT`/`WITH`), belt and
//!    braces in case a future DuckDB feature slips past layer 1.

use std::path::Path;

use duckdb::{AccessMode, Config, Connection};

use crate::error::{AppError, AppResult};

/// Memory ceiling for a pool query — fixes the `memory_limit` gap Ragtag noted (§1.5).
const MAX_QUERY_MEMORY: &str = "2GB";
/// Thread ceiling for a pool query.
const MAX_QUERY_THREADS: i64 = 2;

/// Open a pool database as a hardened, read-only connection for running generated SQL.
///
/// This alone blocks `COPY TO`, `read_csv()`, `httpfs`, `ATTACH`, extension loads, and
/// re-enabling any of the above via `SET`.
pub fn open_for_query(path: &Path) -> AppResult<Connection> {
    let config = Config::default()
        .access_mode(AccessMode::ReadOnly)
        .and_then(|c| c.enable_external_access(false))
        .and_then(|c| c.enable_autoload_extension(false))
        .and_then(|c| c.with("autoinstall_known_extensions", "false"))
        .and_then(|c| c.max_memory(MAX_QUERY_MEMORY))
        .and_then(|c| c.threads(MAX_QUERY_THREADS))
        // Lock last so nothing above can be undone via a `SET` statement.
        .and_then(|c| c.with("lock_configuration", "true"))
        .map_err(|e| AppError::db(format!("failed to build query config: {e}")))?;

    Connection::open_with_flags(path, config)
        .map_err(|e| AppError::db(format!("failed to open pool read-only: {e}")))
}

/// Reject anything that isn't a single read-only `SELECT`/`WITH` statement. Returns the
/// reason on rejection so the repair loop can feed it back to the model.
pub fn is_safe_select(sql: &str) -> AppResult<()> {
    // Strip comments first so forbidden verbs can't be smuggled past the checks.
    let stripped = strip_comments(sql);
    let trimmed = stripped.trim();

    if trimmed.is_empty() {
        return Err(AppError::validation("empty query"));
    }

    // Single statement only: nothing meaningful after the first `;`.
    if let Some(idx) = trimmed.find(';') {
        if !trimmed[idx + 1..].trim().is_empty() {
            return Err(AppError::validation("only a single statement is allowed"));
        }
    }

    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("select") || lower.starts_with("with")) {
        return Err(AppError::validation("query must start with SELECT or WITH"));
    }

    // Word-level allowlist: tokenise on non-identifier chars so `offset`/`asset`/`reset`
    // don't trip the `set` rule, while `read_csv`, `drop`, etc. match exactly.
    for token in lower.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        if FORBIDDEN.contains(&token) {
            return Err(AppError::validation(format!(
                "'{token}' is not allowed — only read-only SELECT queries are permitted"
            )));
        }
    }

    Ok(())
}

/// Statements/functions that must never appear in a pool query.
const FORBIDDEN: &[&str] = &[
    "insert", "update", "delete", "drop", "create", "alter", "attach", "detach", "copy",
    "pragma", "set", "reset", "install", "load", "call", "export", "import", "read_csv",
    "read_parquet", "read_json", "read_text", "read_blob", "glob", "system",
];

/// Remove `-- line` and `/* block */` comments (char-safe for UTF-8 in string literals).
fn strip_comments(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            out.push(' ');
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_plain_select_and_cte() {
        assert!(is_safe_select("SELECT * FROM opportunities WHERE amount > 1000").is_ok());
        assert!(is_safe_select("  with x as (select 1) select * from x  ").is_ok());
    }

    #[test]
    fn rejects_writes_and_ddl() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "DROP TABLE t",
            "CREATE TABLE t (a INT)",
            "ATTACH 'x.db'",
            "COPY t TO 'out.csv'",
            "PRAGMA database_list",
        ] {
            assert!(is_safe_select(sql).is_err(), "should reject: {sql}");
        }
    }

    #[test]
    fn rejects_multi_statement_and_smuggled_comment() {
        assert!(is_safe_select("SELECT 1; DROP TABLE t").is_err());
        // Trailing empty statement is fine.
        assert!(is_safe_select("SELECT 1;").is_ok());
        // A verb smuggled after a line comment is stripped, so the real statement is checked.
        assert!(is_safe_select("SELECT 1 -- DROP TABLE t").is_ok());
    }

    #[test]
    fn rejects_file_and_extension_functions() {
        assert!(is_safe_select("SELECT * FROM read_csv('/etc/passwd')").is_err());
        assert!(is_safe_select("SELECT * FROM glob('/**')").is_err());
        assert!(is_safe_select("SELECT 1; INSTALL httpfs").is_err());
    }

    #[test]
    fn does_not_false_positive_on_similar_column_names() {
        // `offset`, `asset_value`, `reset_date` contain "set"/"reset" as substrings but are
        // distinct tokens — only exact tokens are forbidden.
        assert!(is_safe_select("SELECT asset_value FROM t ORDER BY close_date LIMIT 5 OFFSET 3").is_ok());
    }

    #[test]
    fn read_only_connection_blocks_writes() {
        // Create a pool read-write, then reopen hardened read-only and confirm SELECT works
        // and writes are rejected.
        let dir = std::env::temp_dir().join("upcells-pool-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("safety.duckdb");
        let _ = std::fs::remove_file(&path);
        {
            let rw = Connection::open(&path).expect("open rw");
            rw.execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1),(2),(3);")
                .expect("seed");
        }
        let ro = open_for_query(&path).expect("open read-only");
        let count: i64 = ro
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .expect("select works");
        assert_eq!(count, 3);
        assert!(
            ro.execute_batch("INSERT INTO t VALUES (4)").is_err(),
            "writes must be rejected on a read-only connection"
        );
        let _ = std::fs::remove_file(&path);
    }
}
