use crate::db::{models::SavedQuery, DbConnection};
use crate::error::{AppError, AppResult};
use crate::salesforce::{rest_api as sf_api, types as sf_types};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

// ── Object / field discovery ───────────────────────────────────────────────────

#[tauri::command]
pub async fn list_sobjects(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
) -> AppResult<Vec<sf_types::SObjectListItem>> {
    sf_api::list_sobjects(&db, &connection_id).await
}

#[tauri::command]
pub async fn describe_object(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
    object_name: String,
) -> AppResult<sf_types::DescribeResponse> {
    sf_api::describe_object(&db, &connection_id, &object_name).await
}

// ── Query execution ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn execute_query(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
    soql: String,
    query_id: Option<String>,
    columns: Option<Vec<String>>,
) -> AppResult<sf_types::QueryResult> {
    let (raw_records, total_size) = sf_api::execute_soql(&db, &connection_id, &soql).await?;

    // Flatten nested relationship objects so parent-record traversal values
    // (e.g. `Account.Name` on an Opportunity query) arrive as flat dotted
    // keys instead of `{Account: {Name: "..."}}`.
    let mut records: Vec<serde_json::Value> = raw_records
        .iter()
        .map(|r| serde_json::Value::Object(flatten_sf_record(r)))
        .collect();

    // Determine column order. We prefer the explicit list from the frontend
    // because it's deterministic (matches the SOQL SELECT) and handles the
    // null-reference case — a record with null Account would otherwise show
    // an "Account" key instead of "Account.Name". Fall back to a union of
    // all observed keys if nothing is provided.
    let final_columns: Vec<String> = match columns.filter(|c| !c.is_empty()) {
        Some(provided) => provided,
        None => {
            let mut seen: std::collections::BTreeSet<String> = Default::default();
            for record in &records {
                if let Some(obj) = record.as_object() {
                    for k in obj.keys() {
                        if k != "attributes" {
                            seen.insert(k.clone());
                        }
                    }
                }
            }
            seen.into_iter().collect()
        }
    };

    // Normalise each record so it carries exactly the expected keys. Missing
    // values (null references, unqueried fields) become explicit null cells,
    // giving the UI a stable shape to render.
    for record in records.iter_mut() {
        if let Some(obj) = record.as_object_mut() {
            for col in &final_columns {
                if !obj.contains_key(col) {
                    obj.insert(col.clone(), serde_json::Value::Null);
                }
            }
        }
    }

    let fetched_count = records.len();

    // Update run stats on a saved query if one was provided
    if let Some(qid) = &query_id {
        let now = Utc::now().timestamp();
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let _ = conn.execute(
            "UPDATE saved_queries SET last_run = ?1, last_record_count = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![now, fetched_count as i64, now, qid],
        );
    }

    Ok(sf_types::QueryResult {
        total_size,
        fetched_count,
        records,
        columns: final_columns,
    })
}

/// Flatten a Salesforce record so nested relationship objects become
/// dot-separated keys at the top level. `{Account: {Name: "Acme"}}` becomes
/// `{"Account.Name": "Acme"}`. The SF-internal `attributes` key is dropped.
fn flatten_sf_record(record: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    if let Some(map) = record.as_object() {
        flatten_into(&mut out, "", map);
    }
    out
}

fn flatten_into(
    out: &mut serde_json::Map<String, serde_json::Value>,
    prefix: &str,
    map: &serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in map {
        if key == "attributes" {
            continue;
        }
        let full_key = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{}.{}", prefix, key)
        };

        match value {
            serde_json::Value::Object(nested) => {
                flatten_into(out, &full_key, nested);
            }
            _ => {
                out.insert(full_key, value.clone());
            }
        }
    }
}

// ── Saved query CRUD ───────────────────────────────────────────────────────────

fn row_to_saved_query(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedQuery> {
    Ok(SavedQuery {
        id: row.get(0)?,
        name: row.get(1)?,
        connection_id: row.get(2)?,
        soql_text: row.get(3)?,
        object_name: row.get(4)?,
        last_run: row.get(5)?,
        last_record_count: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const SAVED_QUERY_SELECT: &str = "SELECT id, name, connection_id, soql_text, object_name, \
    last_run, last_record_count, created_at, updated_at FROM saved_queries";

#[tauri::command]
pub async fn list_saved_queries(
    db: tauri::State<'_, DbConnection>,
    connection_id: Option<String>,
) -> AppResult<Vec<SavedQuery>> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;

    if let Some(cid) = &connection_id {
        let mut stmt = conn
            .prepare(&format!(
                "{} WHERE connection_id = ?1 ORDER BY updated_at DESC",
                SAVED_QUERY_SELECT
            ))
            .map_err(|e| AppError::db(e.to_string()))?;

        let rows = stmt
            .query_map(rusqlite::params![cid], row_to_saved_query)
            .map_err(|e| AppError::db(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::db(e.to_string()))
    } else {
        let mut stmt = conn
            .prepare(&format!("{} ORDER BY updated_at DESC", SAVED_QUERY_SELECT))
            .map_err(|e| AppError::db(e.to_string()))?;

        let rows = stmt
            .query_map([], row_to_saved_query)
            .map_err(|e| AppError::db(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::db(e.to_string()))
    }
}

#[tauri::command]
pub async fn save_query(
    db: tauri::State<'_, DbConnection>,
    name: String,
    connection_id: String,
    soql_text: String,
    object_name: Option<String>,
) -> AppResult<SavedQuery> {
    let now = Utc::now().timestamp();
    let id = Uuid::new_v4().to_string();

    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    conn.execute(
        "INSERT INTO saved_queries (id, name, connection_id, soql_text, object_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![id, name, connection_id, soql_text, object_name, now, now],
    )
    .map_err(|e| AppError::db(e.to_string()))?;

    Ok(SavedQuery {
        id,
        name,
        connection_id: Some(connection_id),
        soql_text,
        object_name,
        last_run: None,
        last_record_count: None,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub async fn update_saved_query(
    db: tauri::State<'_, DbConnection>,
    id: String,
    name: Option<String>,
    soql_text: Option<String>,
    object_name: Option<String>,
) -> AppResult<SavedQuery> {
    let now = Utc::now().timestamp();
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;

    if let Some(n) = &name {
        conn.execute(
            "UPDATE saved_queries SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![n, now, id],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }
    if let Some(st) = &soql_text {
        conn.execute(
            "UPDATE saved_queries SET soql_text = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![st, now, id],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }
    if let Some(on) = &object_name {
        conn.execute(
            "UPDATE saved_queries SET object_name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![on, now, id],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }

    conn.query_row(
        &format!("{} WHERE id = ?1", SAVED_QUERY_SELECT),
        rusqlite::params![id],
        row_to_saved_query,
    )
    .map_err(|e| AppError::db(e.to_string()))
}

#[tauri::command]
pub async fn delete_saved_query(
    db: tauri::State<'_, DbConnection>,
    id: String,
) -> AppResult<()> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    conn.execute(
        "DELETE FROM saved_queries WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| AppError::db(e.to_string()))?;
    Ok(())
}

// ── Saved query bundle (import/export) ────────────────────────────────────────
//
// A portable file format for sharing saved queries between Upcells installs.
// Think: a sales leader exports their standard queries and hands the file to
// colleagues, who import it into their own app.
//
// We deliberately strip internal fields (id, connection_id, last_run, etc.) —
// only the portable shape (name + SOQL + object) travels. On import we
// assign fresh IDs, leave connection_id NULL (queries are portable across
// orgs), and reset run stats.

const BUNDLE_FORMAT: &str = "upcells-queries-v1";

#[derive(Debug, Serialize, Deserialize)]
struct SavedQueryBundleItem {
    name: String,
    soql_text: String,
    #[serde(default)]
    object_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SavedQueryBundle {
    format: String,
    exported_at: i64,
    queries: Vec<SavedQueryBundleItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportSavedQueriesResult {
    pub total_in_file: usize,
    pub imported: usize,
    pub renamed: usize,
    pub skipped_duplicates: usize,
}

/// Export saved queries to a JSON file. When `query_ids` is `Some` and
/// non-empty, only queries whose id is in that set are exported; otherwise
/// the entire library is exported.
#[tauri::command]
pub async fn export_saved_queries_to_file(
    db: tauri::State<'_, DbConnection>,
    file_path: String,
    query_ids: Option<Vec<String>>,
) -> AppResult<usize> {
    let queries: Vec<SavedQueryBundleItem> = {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, soql_text, object_name FROM saved_queries ORDER BY name ASC",
            )
            .map_err(|e| AppError::db(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    SavedQueryBundleItem {
                        name: row.get(1)?,
                        soql_text: row.get(2)?,
                        object_name: row.get(3)?,
                    },
                ))
            })
            .map_err(|e| AppError::db(e.to_string()))?;
        let all: Vec<(String, SavedQueryBundleItem)> = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::db(e.to_string()))?;

        match query_ids.filter(|ids| !ids.is_empty()) {
            Some(ids) => {
                let selected: HashSet<String> = ids.into_iter().collect();
                all.into_iter()
                    .filter(|(id, _)| selected.contains(id))
                    .map(|(_, item)| item)
                    .collect()
            }
            None => all.into_iter().map(|(_, item)| item).collect(),
        }
    };

    let count = queries.len();
    let bundle = SavedQueryBundle {
        format: BUNDLE_FORMAT.to_string(),
        exported_at: Utc::now().timestamp(),
        queries,
    };

    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|e| AppError::io(format!("Serialise failed: {}", e)))?;

    std::fs::write(&file_path, json)
        .map_err(|e| AppError::io(format!("Failed to write file: {}", e)))?;

    Ok(count)
}

#[tauri::command]
pub async fn import_saved_queries_from_file(
    db: tauri::State<'_, DbConnection>,
    file_path: String,
) -> AppResult<ImportSavedQueriesResult> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| AppError::io(format!("Failed to read file: {}", e)))?;

    let bundle: SavedQueryBundle = serde_json::from_str(&content)
        .map_err(|e| AppError::validation(format!("Invalid query file: {}", e)))?;

    // Accept any v1 variant — future compatible majors will use a different prefix.
    // Accept both old "cells-queries-" and new "upcells-queries-" for backward compat
    if !bundle.format.starts_with("upcells-queries-") && !bundle.format.starts_with("cells-queries-") {
        return Err(AppError::validation(format!(
            "Unsupported query file format: {}",
            bundle.format
        )));
    }

    let total_in_file = bundle.queries.len();
    let now = Utc::now().timestamp();

    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;

    // Snapshot the current library so we can detect collisions and generate
    // non-colliding names in-memory without re-querying per-row.
    let existing: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT name, soql_text FROM saved_queries")
            .map_err(|e| AppError::db(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| AppError::db(e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::db(e.to_string()))?
    };
    let mut taken_names: HashSet<String> = existing.iter().map(|(n, _)| n.clone()).collect();
    let mut existing_name_to_soql: std::collections::HashMap<String, String> =
        existing.into_iter().collect();

    let mut imported = 0usize;
    let mut renamed = 0usize;
    let mut skipped_duplicates = 0usize;

    for q in bundle.queries {
        // Exact duplicate (same name AND same SOQL): skip silently to avoid
        // cluttering the library on repeated imports of the same file.
        if let Some(existing_soql) = existing_name_to_soql.get(&q.name) {
            if existing_soql.trim() == q.soql_text.trim() {
                skipped_duplicates += 1;
                continue;
            }
        }

        // Name collision with different content: rename with " (2)", " (3)"…
        let final_name = if taken_names.contains(&q.name) {
            renamed += 1;
            find_unique_name(&q.name, &taken_names)
        } else {
            q.name.clone()
        };
        taken_names.insert(final_name.clone());
        existing_name_to_soql.insert(final_name.clone(), q.soql_text.clone());

        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO saved_queries (id, name, connection_id, soql_text, object_name, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?5)",
            rusqlite::params![id, final_name, q.soql_text, q.object_name, now],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
        imported += 1;
    }

    Ok(ImportSavedQueriesResult {
        total_in_file,
        imported,
        renamed,
        skipped_duplicates,
    })
}

fn find_unique_name(base: &str, taken: &HashSet<String>) -> String {
    for n in 2..10_000 {
        let candidate = format!("{} ({})", base, n);
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    // Extremely unlikely fallback
    format!("{} ({})", base, Uuid::new_v4())
}
