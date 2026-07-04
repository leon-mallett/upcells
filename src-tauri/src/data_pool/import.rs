//! Pool import + grid cleaning (§1.2).
//!
//! Turns a messy CSV/XLSX export into a clean DuckDB table. Salesforce report exports carry
//! title/preamble rows, spacer columns, blank headers, and currency-formatted numbers — the
//! cleaning pipeline below is what makes them survive contact with SQL.
//!
//! Pipeline: read grid → drop empty columns → find the dense header row (skipping preamble)
//! → name blank headers `column_N` → de-dupe colliding names → drop empty rows → load as
//! VARCHAR → best-effort currency/locale coercion to DOUBLE (≥80% of a column must match).

use std::collections::HashMap;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use duckdb::Connection;
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// A raw 2D grid of stringified cells, before cleaning.
type RawGrid = Vec<Vec<String>>;

/// A cleaned table ready to load: column names + string rows (uniform width).
#[derive(Debug, Clone, PartialEq)]
pub struct CleanTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// Result of importing a file into a pool.
#[derive(Debug, Clone, Serialize)]
pub struct ImportSummary {
    pub table: String,
    pub columns: Vec<String>,
    pub row_count: usize,
    /// Columns that were coerced from currency-formatted text to DOUBLE.
    pub numeric_columns: Vec<String>,
}

/// Import a CSV file into `table` within the pool database at `pool_db`.
pub fn import_csv(pool_db: &Path, table: &str, csv_path: &Path) -> AppResult<ImportSummary> {
    let grid = read_csv_grid(csv_path)?;
    import_grid(pool_db, table, grid)
}

/// Import the first sheet of an XLSX file into `table` within the pool database.
pub fn import_xlsx(pool_db: &Path, table: &str, xlsx_path: &Path) -> AppResult<ImportSummary> {
    let grid = read_xlsx_grid(xlsx_path)?;
    import_grid(pool_db, table, grid)
}

fn import_grid(pool_db: &Path, table: &str, grid: RawGrid) -> AppResult<ImportSummary> {
    let clean = clean_grid(grid)?;
    let numeric = detect_numeric_columns(&clean);
    let table_safe = safe_table_name(table);

    let conn = Connection::open(pool_db)
        .map_err(|e| AppError::db(format!("failed to open pool for import: {e}")))?;
    create_and_load(&conn, &table_safe, &clean, &numeric)?;

    let numeric_columns = clean
        .columns
        .iter()
        .zip(&numeric)
        .filter_map(|(c, &n)| n.then(|| c.clone()))
        .collect();

    Ok(ImportSummary {
        table: table_safe,
        columns: clean.columns,
        row_count: clean.rows.len(),
        numeric_columns,
    })
}

// ── Grid cleaning (pure) ─────────────────────────────────────────────────────

/// Apply the cleaning pipeline to a raw grid.
pub fn clean_grid(grid: RawGrid) -> AppResult<CleanTable> {
    let width = grid.iter().map(Vec::len).max().unwrap_or(0);
    if grid.is_empty() || width == 0 {
        return Err(AppError::validation("file has no data"));
    }

    // Normalise width and trim cells.
    let rows: Vec<Vec<String>> = grid
        .into_iter()
        .map(|mut r| {
            r.resize(width, String::new());
            r.into_iter().map(|c| c.trim().to_string()).collect()
        })
        .collect();

    // 1. Keep only columns that have at least one non-empty cell.
    let keep: Vec<usize> = (0..width)
        .filter(|&c| rows.iter().any(|r| !r[c].is_empty()))
        .collect();
    if keep.is_empty() {
        return Err(AppError::validation("file has no non-empty columns"));
    }
    let projected: Vec<Vec<String>> = rows
        .iter()
        .map(|r| keep.iter().map(|&c| r[c].clone()).collect())
        .collect();
    let ncols = keep.len();

    // 2. Header = first "dense" row (>50% non-empty), skipping sparse preamble.
    let header_idx = projected
        .iter()
        .position(|r| r.iter().filter(|c| !c.is_empty()).count() * 2 > ncols)
        .ok_or_else(|| AppError::validation("could not find a header row"))?;

    // 3. Name blank headers `column_N`.
    let mut columns: Vec<String> = projected[header_idx]
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if c.is_empty() {
                format!("column_{}", i + 1)
            } else {
                c.replace('"', "'")
            }
        })
        .collect();

    // 4. De-dupe colliding names with `_2`, `_3` suffixes.
    dedupe(&mut columns);

    // 5. Data rows after the header, dropping fully-empty rows.
    let data: Vec<Vec<String>> = projected[header_idx + 1..]
        .iter()
        .filter(|r| r.iter().any(|c| !c.is_empty()))
        .cloned()
        .collect();

    Ok(CleanTable { columns, rows: data })
}

fn dedupe(columns: &mut [String]) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    for c in columns.iter_mut() {
        let count = seen.entry(c.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            *c = format!("{c}_{count}");
        }
    }
}

/// For each column, whether ≥80% of its non-blank values look like formatted currency/numbers.
fn detect_numeric_columns(clean: &CleanTable) -> Vec<bool> {
    (0..clean.columns.len())
        .map(|ci| {
            let values: Vec<&String> = clean
                .rows
                .iter()
                .filter_map(|r| r.get(ci))
                .filter(|v| !v.trim().is_empty())
                .collect();
            if values.is_empty() {
                return false;
            }
            let matches = values.iter().filter(|v| looks_like_currency(v)).count();
            matches * 100 >= values.len() * 80
        })
        .collect()
}

/// Matches `^\s*[£$€]?\s*-?[0-9][0-9,]*(\.[0-9]+)?\s*$` without a regex dependency.
fn looks_like_currency(s: &str) -> bool {
    let mut chars = s.trim().chars().peekable();
    if matches!(chars.peek(), Some('£' | '$' | '€')) {
        chars.next();
    }
    while chars.peek() == Some(&' ') {
        chars.next();
    }
    if chars.peek() == Some(&'-') {
        chars.next();
    }
    let mut saw_digit = false;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            saw_digit = true;
            chars.next();
        } else if c == ',' {
            chars.next();
        } else {
            break;
        }
    }
    if !saw_digit {
        return false;
    }
    if chars.peek() == Some(&'.') {
        chars.next();
        let mut saw_frac = false;
        while let Some(&c) = chars.peek() {
            if c.is_ascii_digit() {
                saw_frac = true;
                chars.next();
            } else {
                break;
            }
        }
        if !saw_frac {
            return false;
        }
    }
    chars.next().is_none()
}

// ── DuckDB load ──────────────────────────────────────────────────────────────

fn create_and_load(
    conn: &Connection,
    table_safe: &str,
    clean: &CleanTable,
    numeric: &[bool],
) -> AppResult<()> {
    let raw = format!("{table_safe}__raw");
    let cols_ddl = clean
        .columns
        .iter()
        .map(|c| format!("{} VARCHAR", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&format!("CREATE TABLE {raw} ({cols_ddl});"))
        .map_err(|e| AppError::db(format!("failed to create table: {e}")))?;

    {
        let mut appender = conn
            .appender(&raw)
            .map_err(|e| AppError::db(format!("failed to open appender: {e}")))?;
        for row in &clean.rows {
            appender
                .append_row(duckdb::appender_params_from_iter(row.iter().map(String::as_str)))
                .map_err(|e| AppError::db(format!("failed to append row: {e}")))?;
        }
        appender
            .flush()
            .map_err(|e| AppError::db(format!("failed to flush rows: {e}")))?;
    }

    // Coercion pass: strip currency symbols/commas/spaces and TRY_CAST numeric columns to
    // DOUBLE; leave genuine text (e.g. "Q1 2025") alone. Empty/unparseable → NULL.
    let select = clean
        .columns
        .iter()
        .zip(numeric)
        .map(|(c, &is_num)| {
            let q = quote_ident(c);
            if is_num {
                format!("TRY_CAST(regexp_replace({q}, '[£$€,\\s]', '', 'g') AS DOUBLE) AS {q}")
            } else {
                q
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&format!(
        "CREATE TABLE {table_safe} AS SELECT {select} FROM {raw}; DROP TABLE {raw};"
    ))
    .map_err(|e| AppError::db(format!("failed to finalise table: {e}")))?;

    Ok(())
}

/// A DuckDB identifier restricted to `[a-z0-9_]`, safe to use unquoted (for the table name).
fn safe_table_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() || s.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        s = format!("t_{s}");
    }
    s
}

/// Double-quote an identifier (for column names, which may contain spaces/odd characters).
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

// ── File readers ─────────────────────────────────────────────────────────────

fn read_csv_grid(path: &Path) -> AppResult<RawGrid> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| AppError::io(format!("failed to open csv: {e}")))?;
    let mut grid = RawGrid::new();
    for record in reader.records() {
        let record = record.map_err(|e| AppError::io(format!("failed to read csv row: {e}")))?;
        grid.push(record.iter().map(str::to_string).collect());
    }
    Ok(grid)
}

fn read_xlsx_grid(path: &Path) -> AppResult<RawGrid> {
    let mut workbook =
        open_workbook_auto(path).map_err(|e| AppError::io(format!("failed to open xlsx: {e}")))?;
    let name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| AppError::validation("workbook has no sheets"))?;
    let range = workbook
        .worksheet_range(&name)
        .map_err(|e| AppError::io(format!("failed to read sheet: {e}")))?;
    let grid = range
        .rows()
        .map(|row| row.iter().map(cell_to_string).collect())
        .collect();
    Ok(grid)
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                (*f as i64).to_string()
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("<error: {e:?}>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_pool::safety::open_for_query;

    #[test]
    fn cleans_messy_export_with_preamble_and_spacers() {
        // Title rows, a spacer column, blank header, currency values, a trailing empty row.
        let grid = vec![
            vec!["Pipeline report".into(), "".into(), "".into()],
            vec!["Generated 2026-07-01".into(), "".into(), "".into()],
            vec!["Opportunity".into(), "".into(), "Amount".into()],
            vec!["Acme".into(), "".into(), "£12,500".into()],
            vec!["Globex".into(), "".into(), "$40,000".into()],
            vec!["".into(), "".into(), "".into()],
        ];
        let clean = clean_grid(grid).expect("clean");
        // Spacer column dropped; header found below the preamble.
        assert_eq!(clean.columns, vec!["Opportunity", "Amount"]);
        assert_eq!(clean.rows.len(), 2);
        assert_eq!(clean.rows[0], vec!["Acme", "£12,500"]);
    }

    #[test]
    fn names_blank_headers_and_dedupes() {
        let grid = vec![
            vec!["Name".into(), "".into(), "Name".into()],
            vec!["a".into(), "b".into(), "c".into()],
        ];
        let clean = clean_grid(grid).expect("clean");
        assert_eq!(clean.columns, vec!["Name", "column_2", "Name_2"]);
    }

    #[test]
    fn currency_detection() {
        assert!(looks_like_currency("£12,500"));
        assert!(looks_like_currency("$40,000.50"));
        assert!(looks_like_currency("-1234"));
        assert!(looks_like_currency("€ 9.99"));
        assert!(!looks_like_currency("Q1 2025"));
        assert!(!looks_like_currency("Closed Won"));
        assert!(!looks_like_currency(""));
    }

    #[test]
    fn imports_csv_and_currency_is_summable() {
        let dir = std::env::temp_dir().join("upcells-import-test");
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("opps.csv");
        std::fs::write(
            &csv,
            "Region,Opportunity,Amount\nUK,Acme,\"£12,500\"\nUK,Globex,\"£40,000\"\nUS,Initech,\"$7,000\"\n",
        )
        .unwrap();
        let pool = dir.join("pool.duckdb");
        let _ = std::fs::remove_file(&pool);

        let summary = import_csv(&pool, "opportunities", &csv).expect("import");
        assert_eq!(summary.row_count, 3);
        assert_eq!(summary.table, "opportunities");
        assert!(summary.numeric_columns.contains(&"Amount".to_string()));

        // Query it through the hardened read-only connection.
        let conn = open_for_query(&pool).expect("read-only open");
        let total: f64 = conn
            .query_row(
                "SELECT sum(\"Amount\") FROM opportunities WHERE \"Region\" = 'UK'",
                [],
                |r| r.get(0),
            )
            .expect("aggregate query");
        assert_eq!(total, 52_500.0);
        let _ = std::fs::remove_file(&pool);
    }
}
