use crate::db::DbConnection;
use crate::error::AppResult;
use crate::salesforce::rest_api as sf_api;

use serde::{Deserialize, Serialize};

// ── Field population analysis ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FieldPopulationInfo {
    pub name: String,
    pub label: String,
    pub field_type: String,
    pub updateable: bool,
    /// Number of records in the sample that have a non-null value for this field.
    pub populated_count: u64,
    /// Total records sampled.
    pub sample_size: u64,
    /// `populated_count / sample_size * 100`, rounded to 1 decimal.
    pub population_pct: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FieldAnalysisResult {
    pub object_name: String,
    pub sample_size: u64,
    pub total_records: u64,
    pub fields: Vec<FieldPopulationInfo>,
}

/// Analyses how populated each field is on a Salesforce object by sampling
/// up to `sample_limit` records and counting non-null values per field.
///
/// This is far more API-efficient than one COUNT query per field — a single
/// SOQL call fetches ALL fields for the sample, and Rust does the counting.
#[tauri::command]
pub async fn analyse_field_population(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
    object_name: String,
    sample_limit: Option<u64>,
) -> AppResult<FieldAnalysisResult> {
    let limit = sample_limit.unwrap_or(2000);

    // 1. Fetch the object describe to get all fields
    let describe = sf_api::describe_object(&db, &connection_id, &object_name).await?;

    // Build SOQL selecting every queryable field. Some fields can't appear in
    // a SOQL SELECT (e.g. compound address, certain blob types) — we filter
    // to safe types.
    let queryable_fields: Vec<_> = describe
        .fields
        .iter()
        .filter(|f| {
            // Skip compound/blob types that can't be in SELECT
            !matches!(
                f.field_type.as_str(),
                "address" | "location" | "base64" | "complexvalue"
            )
        })
        .collect();

    let field_names: Vec<String> = queryable_fields.iter().map(|f| f.name.clone()).collect();
    let select_clause = field_names.join(", ");
    let soql = format!(
        "SELECT {} FROM {} LIMIT {}",
        select_clause, object_name, limit
    );

    // 2. Execute the query
    let (records, total_size) = sf_api::execute_soql(&db, &connection_id, &soql).await?;

    let sample_size = records.len() as u64;

    // 3. Count non-null / non-empty values per field
    let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for record in &records {
        if let Some(obj) = record.as_object() {
            for field_name in &field_names {
                let is_populated = obj
                    .get(field_name)
                    .map(|v| !v.is_null() && v.as_str().map(|s| !s.is_empty()).unwrap_or(true))
                    .unwrap_or(false);
                if is_populated {
                    *counts.entry(field_name.clone()).or_insert(0) += 1;
                }
            }
        }
    }

    // 4. Build results sorted by population rate ascending (emptiest first)
    let mut fields: Vec<FieldPopulationInfo> = queryable_fields
        .iter()
        .map(|f| {
            let populated = *counts.get(&f.name).unwrap_or(&0);
            let pct = if sample_size > 0 {
                (populated as f64 / sample_size as f64 * 1000.0).round() / 10.0
            } else {
                0.0
            };
            FieldPopulationInfo {
                name: f.name.clone(),
                label: f.label.clone(),
                field_type: f.field_type.clone(),
                updateable: f.updateable,
                populated_count: populated,
                sample_size,
                population_pct: pct,
            }
        })
        .collect();

    fields.sort_by(|a, b| a.population_pct.partial_cmp(&b.population_pct).unwrap());

    Ok(FieldAnalysisResult {
        object_name,
        sample_size,
        total_records: total_size,
        fields,
    })
}

// ── Duplicate record detection ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DuplicateGroup {
    /// The value that's duplicated (e.g. the account Name).
    pub value: String,
    /// How many records share this value.
    pub count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DuplicateAnalysisResult {
    pub object_name: String,
    pub field_name: String,
    pub field_label: String,
    pub total_duplicates: usize,
    pub total_affected_records: u64,
    pub groups: Vec<DuplicateGroup>,
}

/// Finds duplicate values in a given field using `GROUP BY ... HAVING COUNT() > 1`.
/// This is a single SOQL call regardless of record count — Salesforce does the
/// heavy lifting server-side.
#[tauri::command]
pub async fn detect_duplicates(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
    object_name: String,
    field_name: String,
    min_count: Option<u64>,
) -> AppResult<DuplicateAnalysisResult> {
    let min = min_count.unwrap_or(2);

    // Get the field label from describe
    let describe = sf_api::describe_object(&db, &connection_id, &object_name).await?;
    let field_label = describe
        .fields
        .iter()
        .find(|f| f.name == field_name)
        .map(|f| f.label.clone())
        .unwrap_or_else(|| field_name.clone());

    let soql = format!(
        "SELECT {field}, COUNT(Id) cnt FROM {object} WHERE {field} != NULL GROUP BY {field} HAVING COUNT(Id) >= {min} ORDER BY COUNT(Id) DESC LIMIT 200",
        field = field_name,
        object = object_name,
        min = min,
    );

    let (records, _) = sf_api::execute_soql(&db, &connection_id, &soql).await?;

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    let mut total_affected: u64 = 0;

    for record in &records {
        if let Some(obj) = record.as_object() {
            let value = obj
                .get(&field_name)
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    _ => v.as_str().map(String::from),
                })
                .unwrap_or_default();

            let count = obj
                .get("cnt")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            total_affected += count;
            groups.push(DuplicateGroup { value, count });
        }
    }

    Ok(DuplicateAnalysisResult {
        object_name,
        field_name,
        field_label,
        total_duplicates: groups.len(),
        total_affected_records: total_affected,
        groups,
    })
}

// ── Record ownership distribution ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OwnershipBucket {
    pub owner_id: String,
    pub owner_name: String,
    pub record_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnershipResult {
    pub object_name: String,
    pub total_records: u64,
    pub owners: Vec<OwnershipBucket>,
}

/// Groups records by OwnerId and resolves owner names via a second query.
/// Two SOQL calls total: one for the GROUP BY, one to look up User names.
#[tauri::command]
pub async fn analyse_record_ownership(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
    object_name: String,
) -> AppResult<OwnershipResult> {
    // 1. Group by OwnerId
    let soql = format!(
        "SELECT OwnerId, COUNT(Id) cnt FROM {} GROUP BY OwnerId ORDER BY COUNT(Id) DESC LIMIT 200",
        object_name
    );
    let (records, _) = sf_api::execute_soql(&db, &connection_id, &soql).await?;

    let mut buckets: Vec<(String, u64)> = Vec::new();
    let mut total: u64 = 0;

    for record in &records {
        if let Some(obj) = record.as_object() {
            let owner_id = obj
                .get("OwnerId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let count = obj.get("cnt").and_then(|v| v.as_u64()).unwrap_or(0);
            total += count;
            if !owner_id.is_empty() {
                buckets.push((owner_id, count));
            }
        }
    }

    // 2. Resolve owner names in a single query
    let owner_ids: Vec<String> = buckets.iter().map(|(id, _)| id.clone()).collect();
    let mut name_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if !owner_ids.is_empty() {
        let id_list = owner_ids
            .iter()
            .map(|id| format!("'{}'", id.replace('\'', "\\'")))
            .collect::<Vec<_>>()
            .join(", ");
        let name_soql = format!(
            "SELECT Id, Name FROM User WHERE Id IN ({}) LIMIT 200",
            id_list
        );
        if let Ok((users, _)) = sf_api::execute_soql(&db, &connection_id, &name_soql).await {
            for u in &users {
                if let Some(obj) = u.as_object() {
                    let id = obj.get("Id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = obj.get("Name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    name_map.insert(id.to_string(), name.to_string());
                }
            }
        }
    }

    let owners: Vec<OwnershipBucket> = buckets
        .into_iter()
        .map(|(id, count)| {
            let name = name_map.get(&id).cloned().unwrap_or_else(|| id.clone());
            OwnershipBucket {
                owner_id: id,
                owner_name: name,
                record_count: count,
            }
        })
        .collect();

    Ok(OwnershipResult {
        object_name,
        total_records: total,
        owners,
    })
}
