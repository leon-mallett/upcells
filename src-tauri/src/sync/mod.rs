//! Diff computation and (later) execution for pushing file edits back to Salesforce.
//!
//! The diff compares each row in a file against the current Salesforce record
//! (fetched by Id via SOQL). A row is classified as:
//!
//!   - `new`        — no Id in file, will be inserted
//!   - `modified`   — Id present, some updateable fields differ
//!   - `unchanged`  — Id present, no updateable fields differ
//!   - `error`      — Id present but record not found in SF, or other row-level issue
//!
//! Non-updateable fields (CreatedDate, formula fields, nested relationship
//! lookups, etc.) are flagged as `skipped_fields` on the whole diff but do not
//! cause per-row errors — they are simply not sent back.

use crate::db::DbConnection;
use crate::error::{AppError, AppResult};
use crate::import::ParsedFile;
use crate::salesforce::{rest_api as sf_api, types as sf_types};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Diff types ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    New,
    Modified,
    Unchanged,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FieldChange {
    pub field: String,
    pub old_value: serde_json::Value,
    pub new_value: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffRow {
    /// 1-based row number in the file (matches spreadsheet row numbers)
    pub row_number: usize,
    pub id: Option<String>,
    pub status: DiffStatus,
    pub changes: Vec<FieldChange>,
    /// For `new` rows, the values that would be inserted (updateable fields only).
    pub new_values: serde_json::Map<String, serde_json::Value>,
    pub error: Option<String>,
    /// Non-fatal validation problems (e.g. restricted-picklist mismatches).
    pub warnings: Vec<String>,
    /// Values from `[Upcells]` action columns (e.g. feed posts, notes). These
    /// aren't Salesforce fields — they trigger side-effects after the main
    /// sync: creating FeedItem or Note records attached to the row's record.
    pub action_values: std::collections::BTreeMap<String, String>,
}

// ── Sync execution result types ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncRecordResult {
    /// Row number in the original file
    pub row_number: usize,
    /// "insert" or "update"
    pub operation: String,
    /// SF Id — set for successful updates and new inserts
    pub id: Option<String>,
    pub success: bool,
    pub error_message: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncResult {
    pub sync_id: String,
    pub object_name: String,
    pub total_attempted: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub inserted_count: usize,
    pub updated_count: usize,
    pub feed_posts_created: usize,
    pub notes_created: usize,
    pub tasks_created: usize,
    pub calls_created: usize,
    pub events_created: usize,
    pub results: Vec<SyncRecordResult>,
    pub started_at: i64,
    pub completed_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiffResult {
    pub object_name: String,
    pub connection_id: String,
    pub total_rows: usize,
    pub new_count: usize,
    pub modified_count: usize,
    pub unchanged_count: usize,
    pub error_count: usize,
    /// Number of rows that have at least one validation warning.
    pub warning_count: usize,
    /// Number of rows with at least one non-empty action column value.
    pub action_count: usize,
    pub rows: Vec<DiffRow>,
    /// Columns present in the file but not updateable via the REST API.
    /// These are shown as an info banner in the UI.
    pub skipped_fields: Vec<String>,
    /// Updateable fields we actually compared.
    pub compared_fields: Vec<String>,
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub async fn compute_diff(
    db: &DbConnection,
    connection_id: &str,
    object_name: &str,
    parsed: &ParsedFile,
) -> AppResult<DiffResult> {
    // 1. Fetch describe to know which fields are updateable and their types
    let describe = sf_api::describe_object(db, connection_id, object_name).await?;

    let field_map: HashMap<String, sf_types::SObjectField> = describe
        .fields
        .iter()
        .map(|f| (f.name.clone(), f.clone()))
        .collect();

    // Fields the REST API will actually accept on update/insert.
    // We also use this set for the "compared fields" list.
    let updateable_fields: HashSet<String> = describe
        .fields
        .iter()
        .filter(|f| is_writeable(f))
        .map(|f| f.name.clone())
        .collect();

    // 2. Work out which file columns are updateable and which we'll skip
    let mut skipped_fields: Vec<String> = Vec::new();
    let mut compared_fields: Vec<String> = Vec::new();

    for col in &parsed.columns {
        if col == "Id" || col == "attributes" {
            continue;
        }
        // Nested relationship columns from SOQL (e.g. "Owner.Name") aren't
        // writeable — skip them.
        if col.contains('.') {
            skipped_fields.push(col.clone());
            continue;
        }
        if updateable_fields.contains(col) {
            compared_fields.push(col.clone());
        } else {
            skipped_fields.push(col.clone());
        }
    }

    // 3. Collect all Ids from the file
    let ids: Vec<String> = parsed
        .rows
        .iter()
        .filter_map(|row| {
            row.get("Id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .collect();

    // 4. Fetch current state for those Ids (in chunks)
    let current_by_id = if ids.is_empty() {
        HashMap::new()
    } else {
        fetch_current_records(db, connection_id, object_name, &compared_fields, &ids).await?
    };

    // Detect [Upcells] action columns (feed posts, notes, etc.)
    let action_col_names: Vec<String> = parsed
        .columns
        .iter()
        .filter(|c| c.starts_with("[Upcells]"))
        .cloned()
        .collect();

    fn extract_action_values(
        row: &serde_json::Map<String, serde_json::Value>,
        action_cols: &[String],
    ) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        for ac in action_cols {
            if let Some(val) = row.get(ac) {
                let s = match val {
                    serde_json::Value::String(s) if !s.is_empty() => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    _ => continue,
                };
                out.insert(ac.clone(), s);
            }
        }
        out
    }

    // 5. Walk rows and classify each
    let mut diff_rows: Vec<DiffRow> = Vec::with_capacity(parsed.rows.len());
    let mut new_count = 0usize;
    let mut modified_count = 0usize;
    let mut unchanged_count = 0usize;
    let mut error_count = 0usize;
    let mut warning_count = 0usize;

    for (idx, row) in parsed.rows.iter().enumerate() {
        let row_number = idx + 2; // +1 for 0-based to 1-based, +1 for header
        let action_values = extract_action_values(row, &action_col_names);

        let id_opt = row
            .get("Id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        // ── New row (no Id) ─────────────────────────────────────────────────
        if id_opt.is_none() {
            let mut new_values = serde_json::Map::new();
            let mut warnings: Vec<String> = Vec::new();

            for col in &compared_fields {
                if let Some(val) = row.get(col) {
                    let field = field_map.get(col);
                    let field_type = field
                        .map(|f| f.field_type.as_str())
                        .unwrap_or("string");
                    let normalized = normalize_value(val, field_type);
                    if !normalized.is_null() {
                        if let Some(f) = field {
                            warnings.extend(validate_cell_value(&normalized, f));
                        }
                        new_values.insert(col.clone(), normalized);
                    }
                }
            }
            if !warnings.is_empty() {
                warning_count += 1;
            }
            new_count += 1;
            diff_rows.push(DiffRow {
                row_number,
                id: None,
                status: DiffStatus::New,
                changes: vec![],
                new_values,
                error: None,
                warnings,
                action_values,
            });
            continue;
        }

        let id = id_opt.unwrap();
        let current = current_by_id.get(&id);

        // ── Id in file but not found in SF ─────────────────────────────────
        if current.is_none() {
            error_count += 1;
            diff_rows.push(DiffRow {
                row_number,
                id: Some(id),
                status: DiffStatus::Error,
                changes: vec![],
                new_values: serde_json::Map::new(),
                error: Some("Record not found in Salesforce".to_string()),
                warnings: vec![],
                action_values: std::collections::BTreeMap::new(),
            });
            continue;
        }

        // ── Existing record — compare field by field ───────────────────────
        let current = current.unwrap();
        let mut changes: Vec<FieldChange> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();

        for col in &compared_fields {
            let file_val = row.get(col).cloned().unwrap_or(serde_json::Value::Null);
            let sf_val = current.get(col).cloned().unwrap_or(serde_json::Value::Null);

            let field = field_map.get(col);
            let field_type = field.map(|f| f.field_type.as_str()).unwrap_or("string");

            let file_norm = normalize_value(&file_val, field_type);
            let sf_norm = normalize_value(&sf_val, field_type);

            if !values_equal(&file_norm, &sf_norm) {
                // Only validate fields that actually changed — unchanged
                // picklist values that were valid before are still valid.
                if let Some(f) = field {
                    warnings.extend(validate_cell_value(&file_norm, f));
                }
                changes.push(FieldChange {
                    field: col.clone(),
                    old_value: sf_norm,
                    new_value: file_norm,
                });
            }
        }

        if changes.is_empty() {
            unchanged_count += 1;
            diff_rows.push(DiffRow {
                row_number,
                id: Some(id),
                status: DiffStatus::Unchanged,
                changes: vec![],
                new_values: serde_json::Map::new(),
                error: None,
                warnings: vec![],
                action_values,
            });
        } else {
            if !warnings.is_empty() {
                warning_count += 1;
            }
            modified_count += 1;
            diff_rows.push(DiffRow {
                row_number,
                id: Some(id),
                status: DiffStatus::Modified,
                changes,
                new_values: serde_json::Map::new(),
                error: None,
                warnings,
                action_values,
            });
        }
    }

    let action_count = diff_rows.iter().filter(|r| !r.action_values.is_empty()).count();

    Ok(DiffResult {
        object_name: object_name.to_string(),
        connection_id: connection_id.to_string(),
        total_rows: parsed.rows.len(),
        new_count,
        modified_count,
        unchanged_count,
        error_count,
        warning_count,
        action_count,
        rows: diff_rows,
        skipped_fields,
        compared_fields,
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// A field is writeable if Salesforce says it is AND it's not an unsupported
/// compound type. The describe API sets `updateable=false` on formula fields,
/// auto-number, rollup summary, and system fields.
fn is_writeable(field: &sf_types::SObjectField) -> bool {
    if !field.updateable && !field.createable {
        return false;
    }
    // Address / location compound fields can't be written to directly — you
    // have to set the component fields instead.
    if field.field_type == "address" || field.field_type == "location" {
        return false;
    }
    true
}

/// Validates a single cell against the field's rules. Returns warning
/// messages for anything that would cause Salesforce to reject the record
/// (currently: restricted picklist mismatches).
fn validate_cell_value(
    val: &serde_json::Value,
    field: &sf_types::SObjectField,
) -> Vec<String> {
    let mut warnings = Vec::new();

    if val.is_null() {
        return warnings;
    }

    // ── Restricted picklist validation ──────────────────────────────────────
    if (field.field_type == "picklist" || field.field_type == "multipicklist")
        && field.restricted_picklist
        && !field.picklist_values.is_empty()
    {
        let active_values: HashSet<String> = field
            .picklist_values
            .iter()
            .filter(|p| p.active)
            .map(|p| p.value.clone())
            .collect();

        let val_str = match val {
            serde_json::Value::String(s) => s.clone(),
            _ => return warnings,
        };

        // Multipicklist values in SF are semicolon-delimited ("A;B;C")
        let pieces: Vec<&str> = if field.field_type == "multipicklist" {
            val_str.split(';').map(|p| p.trim()).filter(|p| !p.is_empty()).collect()
        } else {
            vec![val_str.as_str()]
        };

        let valid_sample = {
            let mut list: Vec<&str> = active_values.iter().map(|s| s.as_str()).collect();
            list.sort();
            if list.len() > 8 {
                format!("{} (and {} more)", list[..8].join(", "), list.len() - 8)
            } else {
                list.join(", ")
            }
        };

        for piece in pieces {
            if !active_values.contains(piece) {
                warnings.push(format!(
                    "'{}' is not a valid option for {}. Allowed: {}",
                    piece, field.name, valid_sample
                ));
            }
        }
    }

    warnings
}

/// Fetches current-state records from Salesforce by Id, chunked to stay under
/// SOQL query length limits.
async fn fetch_current_records(
    db: &DbConnection,
    connection_id: &str,
    object_name: &str,
    fields: &[String],
    ids: &[String],
) -> AppResult<HashMap<String, serde_json::Map<String, serde_json::Value>>> {
    const CHUNK_SIZE: usize = 500;
    let mut out: HashMap<String, serde_json::Map<String, serde_json::Value>> = HashMap::new();

    // Always include Id in the SELECT so we can key by it
    let mut select_fields: Vec<String> = fields.to_vec();
    if !select_fields.iter().any(|f| f == "Id") {
        select_fields.insert(0, "Id".into());
    }

    let select_clause = select_fields.join(", ");

    for chunk in ids.chunks(CHUNK_SIZE) {
        let id_list = chunk
            .iter()
            .map(|id| format!("'{}'", id.replace('\'', "\\'")))
            .collect::<Vec<_>>()
            .join(", ");
        let soql = format!(
            "SELECT {} FROM {} WHERE Id IN ({})",
            select_clause, object_name, id_list
        );

        let (records, _) = sf_api::execute_soql(db, connection_id, &soql).await?;

        for record in records {
            if let Some(obj) = record.as_object() {
                if let Some(id) = obj.get("Id").and_then(|v| v.as_str()) {
                    let mut map = obj.clone();
                    map.remove("attributes");
                    out.insert(id.to_string(), map);
                }
            }
        }
    }

    Ok(out)
}

/// Normalise a value so comparisons work across csv (everything string) and
/// xlsx (numbers/booleans) sources, and so "" is treated as null.
fn normalize_value(val: &serde_json::Value, field_type: &str) -> serde_json::Value {
    use serde_json::Value;

    // Empty strings are null for comparison purposes
    if let Value::String(s) = val {
        if s.is_empty() {
            return Value::Null;
        }
    }
    if val.is_null() {
        return Value::Null;
    }

    match field_type {
        "boolean" => match val {
            Value::Bool(b) => Value::Bool(*b),
            Value::String(s) => {
                let lower = s.to_lowercase();
                if lower == "true" || lower == "1" {
                    Value::Bool(true)
                } else if lower == "false" || lower == "0" {
                    Value::Bool(false)
                } else {
                    Value::Null
                }
            }
            _ => Value::Null,
        },
        "int" | "double" | "currency" | "percent" => match val {
            Value::Number(n) => Value::Number(n.clone()),
            Value::String(s) => s
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::Null,
        },
        "date" => match val {
            // Keep just the YYYY-MM-DD portion — SF returns "2024-01-15" for
            // date fields but datetime strings sometimes sneak in.
            Value::String(s) => {
                let trimmed = if s.len() >= 10 { &s[..10] } else { s.as_str() };
                Value::String(trimmed.to_string())
            }
            _ => Value::Null,
        },
        "datetime" => match val {
            Value::String(s) => Value::String(s.clone()),
            _ => Value::Null,
        },
        // For everything else (string, reference, picklist, etc.) just pass
        // the value through. Nested relationship objects from describe-driven
        // SOQL are handled by being absent from updateable_fields.
        _ => val.clone(),
    }
}

fn values_equal(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Number(x), Value::Number(y)) => {
            // Compare as f64 to avoid int-vs-float mismatches
            x.as_f64().zip(y.as_f64()).map(|(xf, yf)| (xf - yf).abs() < 1e-9).unwrap_or(false)
        }
        _ => a == b,
    }
}

// ── Execution ─────────────────────────────────────────────────────────────────

/// Turns a DiffResult into actual Salesforce API calls. `selected_rows` limits
/// which diff rows are applied — empty means "everything applicable". Rows with
/// warnings are still applied if selected (Salesforce will reject at API time
/// if the value is truly invalid, and the result is surfaced in SyncResult).
///
/// Skips `unchanged` and `error` rows automatically.
pub async fn execute_sync(
    db: &DbConnection,
    diff: &DiffResult,
    source_file_path: Option<String>,
    selected_row_numbers: Option<HashSet<usize>>,
) -> AppResult<SyncResult> {
    use chrono::Utc;
    use uuid::Uuid;

    let sync_id = Uuid::new_v4().to_string();
    let started_at = Utc::now().timestamp();

    // Split into insertable vs updateable batches. We keep a parallel vector
    // of row_numbers so we can map composite API results back to the file rows.
    let mut insert_rows: Vec<(usize, serde_json::Map<String, serde_json::Value>)> = Vec::new();
    let mut update_rows: Vec<(usize, serde_json::Map<String, serde_json::Value>)> = Vec::new();

    for row in &diff.rows {
        if let Some(ref selected) = selected_row_numbers {
            if !selected.contains(&row.row_number) {
                continue;
            }
        }

        match row.status {
            DiffStatus::New => {
                if !row.new_values.is_empty() {
                    insert_rows.push((row.row_number, row.new_values.clone()));
                }
            }
            DiffStatus::Modified => {
                let id = match &row.id {
                    Some(id) => id.clone(),
                    None => continue,
                };
                let mut payload = serde_json::Map::new();
                payload.insert("Id".to_string(), serde_json::Value::String(id));
                for change in &row.changes {
                    payload.insert(change.field.clone(), change.new_value.clone());
                }
                update_rows.push((row.row_number, payload));
            }
            DiffStatus::Unchanged | DiffStatus::Error => {
                // Skip
            }
        }
    }

    // Record the sync_history row in "running" state so failures mid-flight
    // still leave a trace.
    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        conn.execute(
            "INSERT INTO sync_history (id, connection_id, object_name, source_file_path, status, started_at)
             VALUES (?1, ?2, ?3, ?4, 'running', ?5)",
            rusqlite::params![
                sync_id,
                diff.connection_id,
                diff.object_name,
                source_file_path,
                started_at,
            ],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }

    let mut record_results: Vec<SyncRecordResult> = Vec::new();

    // ── Run inserts ──────────────────────────────────────────────────────────
    if !insert_rows.is_empty() {
        let row_numbers: Vec<usize> = insert_rows.iter().map(|(n, _)| *n).collect();
        let payloads: Vec<_> = insert_rows.into_iter().map(|(_, p)| p).collect();

        match sf_api::composite_create(db, &diff.connection_id, &diff.object_name, payloads).await {
            Ok(results) => {
                for (row_number, res) in row_numbers.into_iter().zip(results.into_iter()) {
                    record_results.push(composite_to_sync_result(row_number, "insert", res));
                }
            }
            Err(e) => {
                // Whole batch failed — mark all as failed with this error
                for row_number in row_numbers {
                    record_results.push(SyncRecordResult {
                        row_number,
                        operation: "insert".into(),
                        id: None,
                        success: false,
                        error_message: Some(e.message.clone()),
                        error_code: Some(e.code.clone()),
                    });
                }
            }
        }
    }

    // ── Run updates ──────────────────────────────────────────────────────────
    if !update_rows.is_empty() {
        let row_numbers: Vec<usize> = update_rows.iter().map(|(n, _)| *n).collect();
        let payloads: Vec<_> = update_rows.into_iter().map(|(_, p)| p).collect();

        match sf_api::composite_update(db, &diff.connection_id, &diff.object_name, payloads).await {
            Ok(results) => {
                for (row_number, res) in row_numbers.into_iter().zip(results.into_iter()) {
                    record_results.push(composite_to_sync_result(row_number, "update", res));
                }
            }
            Err(e) => {
                for row_number in row_numbers {
                    record_results.push(SyncRecordResult {
                        row_number,
                        operation: "update".into(),
                        id: None,
                        success: false,
                        error_message: Some(e.message.clone()),
                        error_code: Some(e.code.clone()),
                    });
                }
            }
        }
    }

    // ── Process action columns (Feed Posts, Notes) ─────────────────────────
    // Build a map of row_number → Salesforce Id, pulling from:
    //   - Existing rows: row.id
    //   - Newly inserted rows: the Id returned by composite_create
    let id_by_row: HashMap<usize, String> = {
        let mut m: HashMap<usize, String> = HashMap::new();
        for row in &diff.rows {
            if let Some(id) = &row.id {
                m.insert(row.row_number, id.clone());
            }
        }
        for r in &record_results {
            if r.success && r.operation == "insert" {
                if let Some(id) = &r.id {
                    m.insert(r.row_number, id.clone());
                }
            }
        }
        m
    };

    let mut feed_posts_created = 0usize;
    let mut notes_created = 0usize;

    // Collect FeedItem payloads
    let feed_items: Vec<serde_json::Map<String, serde_json::Value>> = diff
        .rows
        .iter()
        .filter_map(|row| {
            let body = row.action_values.get(crate::commands::export::ACTION_COL_FEED_POST)?;
            let parent_id = id_by_row.get(&row.row_number)?;
            let mut map = serde_json::Map::new();
            map.insert("ParentId".into(), serde_json::Value::String(parent_id.clone()));
            map.insert("Body".into(), serde_json::Value::String(body.clone()));
            Some(map)
        })
        .collect();

    if !feed_items.is_empty() {
        match sf_api::composite_create(db, &diff.connection_id, "FeedItem", feed_items).await {
            Ok(results) => {
                feed_posts_created = results.iter().filter(|r| r.success).count();
                for r in results {
                    if !r.success {
                        let msg = r.errors.first().map(|e| e.message.clone()).unwrap_or_default();
                        record_results.push(SyncRecordResult {
                            row_number: 0, // can't correlate exactly, best-effort
                            operation: "feed_post".into(),
                            id: None,
                            success: false,
                            error_message: Some(msg),
                            error_code: r.errors.first().map(|e| e.status_code.clone()),
                        });
                    }
                }
            }
            Err(e) => {
                record_results.push(SyncRecordResult {
                    row_number: 0,
                    operation: "feed_post".into(),
                    id: None,
                    success: false,
                    error_message: Some(format!("Feed post batch failed: {}", e.message)),
                    error_code: Some(e.code),
                });
            }
        }
    }

    // Collect Note payloads (legacy Note sObject — shows in Notes & Attachments)
    let note_items: Vec<serde_json::Map<String, serde_json::Value>> = diff
        .rows
        .iter()
        .filter_map(|row| {
            let body = row.action_values.get(crate::commands::export::ACTION_COL_NOTE)?;
            let parent_id = id_by_row.get(&row.row_number)?;
            let mut map = serde_json::Map::new();
            map.insert("ParentId".into(), serde_json::Value::String(parent_id.clone()));
            map.insert("Title".into(), serde_json::Value::String("Note from Upcells".into()));
            map.insert("Body".into(), serde_json::Value::String(body.clone()));
            Some(map)
        })
        .collect();

    if !note_items.is_empty() {
        match sf_api::composite_create(db, &diff.connection_id, "Note", note_items).await {
            Ok(results) => {
                notes_created = results.iter().filter(|r| r.success).count();
                for r in results {
                    if !r.success {
                        let msg = r.errors.first().map(|e| e.message.clone()).unwrap_or_default();
                        record_results.push(SyncRecordResult {
                            row_number: 0,
                            operation: "note".into(),
                            id: None,
                            success: false,
                            error_message: Some(msg),
                            error_code: r.errors.first().map(|e| e.status_code.clone()),
                        });
                    }
                }
            }
            Err(e) => {
                record_results.push(SyncRecordResult {
                    row_number: 0,
                    operation: "note".into(),
                    id: None,
                    success: false,
                    error_message: Some(format!("Note batch failed: {}", e.message)),
                    error_code: Some(e.code),
                });
            }
        }
    }

    // Collect Task payloads — the parent-id field depends on object type:
    // Contact/Lead use WhoId, everything else uses WhatId.
    let mut tasks_created = 0usize;
    let task_id_field = if ["Contact", "Lead"].contains(&diff.object_name.as_str()) {
        "WhoId"
    } else {
        "WhatId"
    };

    let task_items: Vec<serde_json::Map<String, serde_json::Value>> = diff
        .rows
        .iter()
        .filter_map(|row| {
            let subject = row.action_values.get(crate::commands::export::ACTION_COL_TASK)?;
            let parent_id = id_by_row.get(&row.row_number)?;
            let mut map = serde_json::Map::new();
            map.insert(task_id_field.into(), serde_json::Value::String(parent_id.clone()));
            map.insert("Subject".into(), serde_json::Value::String(subject.clone()));
            map.insert("Status".into(), serde_json::Value::String("Not Started".into()));
            map.insert("Priority".into(), serde_json::Value::String("Normal".into()));
            Some(map)
        })
        .collect();

    if !task_items.is_empty() {
        match sf_api::composite_create(db, &diff.connection_id, "Task", task_items).await {
            Ok(results) => {
                tasks_created = results.iter().filter(|r| r.success).count();
                for r in results {
                    if !r.success {
                        let msg = r.errors.first().map(|e| e.message.clone()).unwrap_or_default();
                        record_results.push(SyncRecordResult {
                            row_number: 0,
                            operation: "task".into(),
                            id: None,
                            success: false,
                            error_message: Some(msg),
                            error_code: r.errors.first().map(|e| e.status_code.clone()),
                        });
                    }
                }
            }
            Err(e) => {
                record_results.push(SyncRecordResult {
                    row_number: 0,
                    operation: "task".into(),
                    id: None,
                    success: false,
                    error_message: Some(format!("Task batch failed: {}", e.message)),
                    error_code: Some(e.code),
                });
            }
        }
    }

    // Collect Log Call payloads — a Task with Type='Call' and Status='Completed'
    let mut calls_created = 0usize;
    let call_items: Vec<serde_json::Map<String, serde_json::Value>> = diff
        .rows
        .iter()
        .filter_map(|row| {
            let subject = row.action_values.get(crate::commands::export::ACTION_COL_CALL)?;
            let parent_id = id_by_row.get(&row.row_number)?;
            let mut map = serde_json::Map::new();
            map.insert(task_id_field.into(), serde_json::Value::String(parent_id.clone()));
            map.insert("Subject".into(), serde_json::Value::String(format!("Call: {}", subject)));
            map.insert("Status".into(), serde_json::Value::String("Completed".into()));
            map.insert("Priority".into(), serde_json::Value::String("Normal".into()));
            map.insert("Type".into(), serde_json::Value::String("Call".into()));
            map.insert("Description".into(), serde_json::Value::String(subject.clone()));
            Some(map)
        })
        .collect();

    if !call_items.is_empty() {
        match sf_api::composite_create(db, &diff.connection_id, "Task", call_items).await {
            Ok(results) => {
                calls_created = results.iter().filter(|r| r.success).count();
                for r in results {
                    if !r.success {
                        let msg = r.errors.first().map(|e| e.message.clone()).unwrap_or_default();
                        record_results.push(SyncRecordResult {
                            row_number: 0,
                            operation: "call".into(),
                            id: None,
                            success: false,
                            error_message: Some(msg),
                            error_code: r.errors.first().map(|e| e.status_code.clone()),
                        });
                    }
                }
            }
            Err(e) => {
                record_results.push(SyncRecordResult {
                    row_number: 0, operation: "call".into(), id: None, success: false,
                    error_message: Some(format!("Call batch failed: {}", e.message)),
                    error_code: Some(e.code),
                });
            }
        }
    }

    // Collect Event payloads
    let mut events_created = 0usize;
    let event_id_field = if ["Contact", "Lead"].contains(&diff.object_name.as_str()) {
        "WhoId"
    } else {
        "WhatId"
    };

    let event_items: Vec<serde_json::Map<String, serde_json::Value>> = diff
        .rows
        .iter()
        .filter_map(|row| {
            let subject = row.action_values.get(crate::commands::export::ACTION_COL_EVENT)?;
            let parent_id = id_by_row.get(&row.row_number)?;
            let mut map = serde_json::Map::new();
            map.insert(event_id_field.into(), serde_json::Value::String(parent_id.clone()));
            map.insert("Subject".into(), serde_json::Value::String(subject.clone()));
            // Default to a 1-hour event starting now
            let now = Utc::now();
            map.insert("StartDateTime".into(), serde_json::Value::String(
                now.format("%Y-%m-%dT%H:%M:%SZ").to_string()
            ));
            map.insert("EndDateTime".into(), serde_json::Value::String(
                (now + chrono::Duration::hours(1)).format("%Y-%m-%dT%H:%M:%SZ").to_string()
            ));
            Some(map)
        })
        .collect();

    if !event_items.is_empty() {
        match sf_api::composite_create(db, &diff.connection_id, "Event", event_items).await {
            Ok(results) => {
                events_created = results.iter().filter(|r| r.success).count();
                for r in results {
                    if !r.success {
                        let msg = r.errors.first().map(|e| e.message.clone()).unwrap_or_default();
                        record_results.push(SyncRecordResult {
                            row_number: 0,
                            operation: "event".into(),
                            id: None,
                            success: false,
                            error_message: Some(msg),
                            error_code: r.errors.first().map(|e| e.status_code.clone()),
                        });
                    }
                }
            }
            Err(e) => {
                record_results.push(SyncRecordResult {
                    row_number: 0, operation: "event".into(), id: None, success: false,
                    error_message: Some(format!("Event batch failed: {}", e.message)),
                    error_code: Some(e.code),
                });
            }
        }
    }

    // Sort results back into row order
    record_results.sort_by_key(|r| r.row_number);

    let completed_at = Utc::now().timestamp();
    let success_count = record_results.iter().filter(|r| r.success).count();
    let failure_count = record_results.len() - success_count;
    let inserted_count = record_results
        .iter()
        .filter(|r| r.success && r.operation == "insert")
        .count();
    let updated_count = record_results
        .iter()
        .filter(|r| r.success && r.operation == "update")
        .count();

    // Final status + per-record rows, in a single transaction
    {
        let mut conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::db(e.to_string()))?;

        let status = if failure_count == 0 {
            "success"
        } else if success_count == 0 {
            "failed"
        } else {
            "partial"
        };

        tx.execute(
            "UPDATE sync_history SET status = ?1, records_inserted = ?2, records_modified = ?3, completed_at = ?4 WHERE id = ?5",
            rusqlite::params![
                status,
                inserted_count as i64,
                updated_count as i64,
                completed_at,
                sync_id,
            ],
        )
        .map_err(|e| AppError::db(e.to_string()))?;

        for r in &record_results {
            tx.execute(
                "INSERT INTO sync_record_results (id, sync_id, salesforce_id, operation, success, error_code, error_message)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    Uuid::new_v4().to_string(),
                    sync_id,
                    r.id,
                    r.operation,
                    r.success as i64,
                    r.error_code,
                    r.error_message,
                ],
            )
            .map_err(|e| AppError::db(e.to_string()))?;
        }

        tx.commit().map_err(|e| AppError::db(e.to_string()))?;
    }

    Ok(SyncResult {
        sync_id,
        object_name: diff.object_name.clone(),
        total_attempted: record_results.len(),
        success_count,
        failure_count,
        inserted_count,
        updated_count,
        feed_posts_created,
        notes_created,
        tasks_created,
        calls_created,
        events_created,
        results: record_results,
        started_at,
        completed_at,
    })
}

fn composite_to_sync_result(
    row_number: usize,
    operation: &str,
    res: sf_api::CompositeRecordResult,
) -> SyncRecordResult {
    if res.success {
        SyncRecordResult {
            row_number,
            operation: operation.into(),
            id: res.id,
            success: true,
            error_message: None,
            error_code: None,
        }
    } else {
        let (code, message) = res
            .errors
            .first()
            .map(|e| (Some(e.status_code.clone()), Some(e.message.clone())))
            .unwrap_or((None, Some("Unknown error".to_string())));
        SyncRecordResult {
            row_number,
            operation: operation.into(),
            id: res.id,
            success: false,
            error_message: message,
            error_code: code,
        }
    }
}
