use crate::db::{models::ExportHistoryRecord, DbConnection};
use crate::error::{AppError, AppResult};
use crate::export::{self, ExportMetadata};
use crate::salesforce::rest_api as sf_api;

use chrono::Utc;
use std::collections::BTreeMap;
use uuid::Uuid;

/// Writes the given records to xlsx or csv and logs the export.
///
/// Field types are fetched from the Salesforce describe API when `object_name`
/// is provided. They're embedded in the xlsx Metadata sheet (or a sibling
/// .meta.json for csv) so that the later Update feature can type-convert
/// cells correctly on import.
/// Action columns are special Upcells-internal columns (prefixed `[Upcells]`)
/// that trigger side-effects on import rather than field updates. They're
/// exported as empty cells so the user can fill them in their spreadsheet.
pub const ACTION_COL_FEED_POST: &str = "[Upcells] Feed Post";
pub const ACTION_COL_NOTE: &str = "[Upcells] Note";
pub const ACTION_COL_TASK: &str = "[Upcells] Task";
pub const ACTION_COL_CALL: &str = "[Upcells] Log Call";
pub const ACTION_COL_EVENT: &str = "[Upcells] Event";

#[tauri::command]
pub async fn export_query_results(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
    connection_name: String,
    object_name: Option<String>,
    query_id: Option<String>,
    soql: String,
    records: Vec<serde_json::Value>,
    columns: Vec<String>,
    file_path: String,
    format: String,
    action_columns: Option<Vec<String>>,
) -> AppResult<ExportHistoryRecord> {
    // Merge regular columns + action columns into the full column list.
    // Action columns appear at the end so they don't disrupt field ordering.
    let mut all_columns = columns.clone();
    if let Some(action_cols) = &action_columns {
        for ac in action_cols {
            if !all_columns.contains(ac) {
                all_columns.push(ac.clone());
            }
        }
    }

    // ── Fetch field types + picklist values from describe (best-effort)
    let mut field_types: BTreeMap<String, String> = BTreeMap::new();
    let mut picklist_options: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Some(obj) = &object_name {
        if let Ok(describe) = sf_api::describe_object(&db, &connection_id, obj).await {
            for f in describe.fields {
                if all_columns.contains(&f.name) {
                    field_types.insert(f.name.clone(), f.field_type.clone());
                    // Collect active picklist values for xlsx dropdown validation
                    if (f.field_type == "picklist" || f.field_type == "multipicklist")
                        && !f.picklist_values.is_empty()
                    {
                        let active: Vec<String> = f
                            .picklist_values
                            .iter()
                            .filter(|p| p.active)
                            .map(|p| p.value.clone())
                            .collect();
                        if !active.is_empty() {
                            picklist_options.insert(f.name.clone(), active);
                        }
                    }
                }
            }
        }
    }
    // Mark action columns in field_types so the importer knows they're special
    for ac in action_columns.as_deref().unwrap_or(&[]) {
        field_types.insert(ac.clone(), "upcells_action".to_string());
    }

    let metadata = ExportMetadata {
        connection_name,
        object_name: object_name.clone().unwrap_or_default(),
        soql,
        exported_at: Utc::now().timestamp(),
        record_count: records.len(),
        field_types,
    };

    // ── Write file (action columns appear as empty cells — the user fills
    // them in their spreadsheet, then Cells creates the notes on import)
    match format.as_str() {
        "xlsx" => export::write_xlsx(&file_path, &all_columns, &records, &metadata, &picklist_options)?,
        "csv" => {
            export::write_csv(&file_path, &all_columns, &records)?;
            export::write_metadata_json(&file_path, &metadata)?;
        }
        other => {
            return Err(AppError::validation(format!(
                "Unsupported export format: {}",
                other
            )))
        }
    }

    // ── Log to export_history
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp();
    let record_count = records.len() as i64;

    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        conn.execute(
            "INSERT INTO export_history (id, query_id, connection_id, file_path, format, record_count, exported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id,
                query_id,
                connection_id,
                file_path,
                format,
                record_count,
                now,
            ],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }

    Ok(ExportHistoryRecord {
        id,
        query_id,
        connection_id: Some(connection_id),
        file_path,
        format,
        record_count: Some(record_count),
        exported_at: now,
    })
}

#[tauri::command]
pub async fn list_export_history(
    db: tauri::State<'_, DbConnection>,
    limit: Option<i64>,
) -> AppResult<Vec<ExportHistoryRecord>> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;

    let lim = limit.unwrap_or(50);
    let mut stmt = conn
        .prepare(
            "SELECT id, query_id, connection_id, file_path, format, record_count, exported_at
             FROM export_history
             ORDER BY exported_at DESC
             LIMIT ?1",
        )
        .map_err(|e| AppError::db(e.to_string()))?;

    let rows = stmt
        .query_map(rusqlite::params![lim], |row| {
            Ok(ExportHistoryRecord {
                id: row.get(0)?,
                query_id: row.get(1)?,
                connection_id: row.get(2)?,
                file_path: row.get(3)?,
                format: row.get(4)?,
                record_count: row.get(5)?,
                exported_at: row.get(6)?,
            })
        })
        .map_err(|e| AppError::db(e.to_string()))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::db(e.to_string()))
}
