use crate::db::{models::SyncHistoryRecord, DbConnection};
use crate::error::{AppError, AppResult};
use crate::import::{self, DateLocale, ParsedFile};
use crate::sync::{self, DiffResult, SyncResult};
use std::collections::HashSet;

#[tauri::command]
pub async fn read_import_file(
    file_path: String,
    date_locale: Option<DateLocale>,
) -> AppResult<ParsedFile> {
    import::read_file(&file_path, date_locale.unwrap_or_default())
}

/// Reads the file, then compares its rows against current Salesforce state.
///
/// `object_name` and `connection_id` can be passed in explicitly (e.g. user
/// picked them in the UI) or left to the embedded ExportMetadata. When both
/// are missing we return an error — we can't diff without knowing either.
#[tauri::command]
pub async fn compute_sync_diff(
    db: tauri::State<'_, DbConnection>,
    file_path: String,
    connection_id: Option<String>,
    object_name: Option<String>,
    date_locale: Option<DateLocale>,
) -> AppResult<DiffResult> {
    let parsed = import::read_file(&file_path, date_locale.unwrap_or_default())?;

    let connection_id = connection_id
        .or_else(|| {
            // We don't round-trip connection_id in metadata — only name. Defer to caller.
            None
        })
        .ok_or_else(|| AppError::validation("No connection specified for sync"))?;

    let object_name = object_name
        .or_else(|| parsed.metadata.as_ref().map(|m| m.object_name.clone()))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::validation("No object specified for sync — file metadata is missing"))?;

    sync::compute_diff(&db, &connection_id, &object_name, &parsed).await
}

/// Executes a previously-computed diff against Salesforce via the Composite API.
///
/// The frontend passes the full `DiffResult` back — this is intentional. The
/// user has seen and implicitly approved the diff by clicking Apply, so
/// re-computing would risk drift (e.g. someone edits a record in SF between
/// preview and apply). If that's a concern the user can always click Compare
/// again before Apply.
#[tauri::command]
pub async fn execute_sync(
    db: tauri::State<'_, DbConnection>,
    diff: DiffResult,
    source_file_path: Option<String>,
    selected_row_numbers: Option<Vec<usize>>,
) -> AppResult<SyncResult> {
    let selected = selected_row_numbers.map(|v| v.into_iter().collect::<HashSet<_>>());
    sync::execute_sync(&db, &diff, source_file_path, selected).await
}

#[tauri::command]
pub async fn list_sync_history(
    db: tauri::State<'_, DbConnection>,
    limit: Option<i64>,
) -> AppResult<Vec<SyncHistoryRecord>> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    let lim = limit.unwrap_or(100);

    let mut stmt = conn
        .prepare(
            "SELECT id, connection_id, query_id, object_name, source_file_path, status,
                    records_modified, records_inserted, records_deleted, started_at,
                    completed_at, error_summary
             FROM sync_history
             ORDER BY started_at DESC
             LIMIT ?1",
        )
        .map_err(|e| AppError::db(e.to_string()))?;

    let rows = stmt
        .query_map(rusqlite::params![lim], |row| {
            Ok(SyncHistoryRecord {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                query_id: row.get(2)?,
                object_name: row.get(3)?,
                source_file_path: row.get(4)?,
                status: row.get(5)?,
                records_modified: row.get(6)?,
                records_inserted: row.get(7)?,
                records_deleted: row.get(8)?,
                started_at: row.get(9)?,
                completed_at: row.get(10)?,
                error_summary: row.get(11)?,
            })
        })
        .map_err(|e| AppError::db(e.to_string()))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::db(e.to_string()))
}
