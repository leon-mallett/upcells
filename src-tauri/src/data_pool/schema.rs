//! Schema capture for text-to-SQL (§1.3).
//!
//! Not full DDL — a compact plain-text listing **with sample values**, which is the single
//! most useful thing for text-to-SQL quality: it lets a weak model route "closed won" to the
//! `stage` column by matching sample values, without any semantic layer. Also computes
//! deterministic join hints across tables so the model doesn't have to guess relationships.

use std::path::Path;

use serde::Serialize;

use crate::data_pool::safety::open_for_query;
use crate::error::{AppError, AppResult};

/// Max distinct sample values captured per column.
const MAX_SAMPLES: usize = 5;
/// Truncate long sample values in the rendered prompt.
const SAMPLE_MAX_LEN: usize = 40;

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub sql_type: String,
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableInfo {
    pub name: String,
    pub row_count: u64,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PoolSchema {
    pub tables: Vec<TableInfo>,
}

/// Introspect a pool database into a [`PoolSchema`] with per-column sample values.
pub fn capture_schema(pool_db: &Path) -> AppResult<PoolSchema> {
    let conn = open_for_query(pool_db)?;

    let table_names: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT table_name FROM information_schema.tables \
                 WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name",
            )
            .map_err(|e| AppError::db(format!("failed to list tables: {e}")))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| AppError::db(format!("failed to read tables: {e}")))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| AppError::db(format!("failed to read tables: {e}")))?
    };

    let mut tables = Vec::new();
    for table in table_names {
        let columns_meta: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT column_name, data_type FROM information_schema.columns \
                     WHERE table_name = ? ORDER BY ordinal_position",
                )
                .map_err(|e| AppError::db(format!("failed to describe {table}: {e}")))?;
            let rows = stmt
                .query_map([&table], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| AppError::db(format!("failed to read columns: {e}")))?;
            rows.collect::<Result<_, _>>()
                .map_err(|e| AppError::db(format!("failed to read columns: {e}")))?
        };

        let row_count: u64 = conn
            .query_row(&format!("SELECT count(*) FROM {}", quote_ident(&table)), [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| AppError::db(format!("failed to count {table}: {e}")))? as u64;

        let mut columns = Vec::new();
        for (name, sql_type) in columns_meta {
            let samples = sample_values(&conn, &table, &name)?;
            columns.push(ColumnInfo { name, sql_type, samples });
        }
        tables.push(TableInfo { name: table, row_count, columns });
    }

    Ok(PoolSchema { tables })
}

fn sample_values(conn: &duckdb::Connection, table: &str, column: &str) -> AppResult<Vec<String>> {
    let sql = format!(
        "SELECT DISTINCT CAST({col} AS VARCHAR) FROM {tbl} WHERE {col} IS NOT NULL LIMIT {n}",
        col = quote_ident(column),
        tbl = quote_ident(table),
        n = MAX_SAMPLES,
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| AppError::db(format!("failed to sample {column}: {e}")))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| AppError::db(format!("failed to sample {column}: {e}")))?;
    rows.collect::<Result<_, _>>()
        .map_err(|e| AppError::db(format!("failed to sample {column}: {e}")))
}

/// Render the schema as the compact prompt block the model sees (§1.3). Column names are
/// double-quoted exactly as stored so the model copies them verbatim.
pub fn render_prompt_schema(schema: &PoolSchema) -> String {
    let mut out = String::new();
    for table in &schema.tables {
        out.push_str(&format!(
            "- Table {} ({} rows):\n",
            quote_ident(&table.name),
            table.row_count
        ));
        for col in &table.columns {
            out.push_str(&format!("    - {} {}", quote_ident(&col.name), col.sql_type));
            if !col.samples.is_empty() {
                let shown: Vec<String> = col
                    .samples
                    .iter()
                    .map(|s| truncate(s, SAMPLE_MAX_LEN))
                    .collect();
                out.push_str(&format!(" (e.g. {})", shown.join(", ")));
            }
            out.push('\n');
        }
    }
    out
}

/// Deterministic join hints: columns that match by normalised name and compatible type across
/// tables, plus a worked `JOIN … GROUP BY` example built from the real schema.
pub fn join_hints(schema: &PoolSchema) -> Vec<String> {
    let mut hints = Vec::new();
    for (i, a) in schema.tables.iter().enumerate() {
        for b in schema.tables.iter().skip(i + 1) {
            for ca in &a.columns {
                for cb in &b.columns {
                    if normalise(&ca.name) == normalise(&cb.name)
                        && type_group(&ca.sql_type) == type_group(&cb.sql_type)
                    {
                        hints.push(format!(
                            "{}.{} likely joins {}.{}",
                            quote_ident(&a.name),
                            quote_ident(&ca.name),
                            quote_ident(&b.name),
                            quote_ident(&cb.name),
                        ));
                    }
                }
            }
        }
    }
    hints
}

/// A per-request worked example query built from real columns (a text column grouped by a
/// numeric aggregate), teaching exact quoting like `SUM("amount")`.
pub fn worked_example(schema: &PoolSchema) -> Option<String> {
    let table = schema.tables.first()?;
    let numeric = table.columns.iter().find(|c| type_group(&c.sql_type) == TypeGroup::Numeric)?;
    let text = table
        .columns
        .iter()
        .find(|c| type_group(&c.sql_type) == TypeGroup::Text)?;
    Some(format!(
        "SELECT {t}, SUM({n}) AS total FROM {tbl} GROUP BY {t} ORDER BY total DESC LIMIT 5",
        t = quote_ident(&text.name),
        n = quote_ident(&numeric.name),
        tbl = quote_ident(&table.name),
    ))
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum TypeGroup {
    Numeric,
    Text,
    Other,
}

fn type_group(sql_type: &str) -> TypeGroup {
    let t = sql_type.to_uppercase();
    if ["INT", "DOUBLE", "DECIMAL", "FLOAT", "REAL", "NUMERIC", "HUGEINT"]
        .iter()
        .any(|k| t.contains(k))
    {
        TypeGroup::Numeric
    } else if t.contains("CHAR") || t.contains("TEXT") || t.contains("STRING") {
        TypeGroup::Text
    } else {
        TypeGroup::Other
    }
}

fn normalise(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s.to_string()
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_pool::import::import_csv;

    fn seed_pool() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("upcells-schema-test");
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("opps.csv");
        std::fs::write(
            &csv,
            "Stage,Amount\nProspecting,\"£1,000\"\nClosed Won,\"£40,000\"\nClosed Won,\"£12,500\"\n",
        )
        .unwrap();
        let pool = dir.join("schema.duckdb");
        let _ = std::fs::remove_file(&pool);
        import_csv(&pool, "opportunities", &csv).unwrap();
        pool
    }

    #[test]
    fn captures_columns_types_and_samples() {
        let pool = seed_pool();
        let schema = capture_schema(&pool).expect("capture");
        assert_eq!(schema.tables.len(), 1);
        let t = &schema.tables[0];
        assert_eq!(t.name, "opportunities");
        assert_eq!(t.row_count, 3);
        let stage = t.columns.iter().find(|c| c.name == "Stage").unwrap();
        assert!(stage.sql_type.to_uppercase().contains("VARCHAR"));
        assert!(stage.samples.iter().any(|s| s == "Closed Won"));
        let amount = t.columns.iter().find(|c| c.name == "Amount").unwrap();
        assert_eq!(type_group(&amount.sql_type), TypeGroup::Numeric);
    }

    #[test]
    fn renders_prompt_with_samples() {
        let pool = seed_pool();
        let schema = capture_schema(&pool).expect("capture");
        let text = render_prompt_schema(&schema);
        assert!(text.contains("Table \"opportunities\" (3 rows)"));
        assert!(text.contains("\"Stage\""));
        assert!(text.contains("e.g."));
        // A worked example is available and uses quoted identifiers.
        let example = worked_example(&schema).unwrap();
        assert!(example.contains("SUM(\"Amount\")"));
    }
}
