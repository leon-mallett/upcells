use serde::{Deserialize, Serialize};

/// Metadata for a data pool (a `{id}.duckdb` file under `app_data_dir/pools`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DataPool {
    pub id: String,
    pub name: String,
    pub table_name: String,
    pub source_file: Option<String>,
    pub row_count: i64,
    pub columns: Vec<String>,
    pub created_at: i64,
}

/// Metadata for a knowledge source (an ingested document/URL for prospecting RAG).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KnowledgeSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub location: Option<String>,
    pub chunk_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub connection_type: String,
    pub instance_url: Option<String>,
    pub client_id: Option<String>,
    pub username: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_tested: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionInput {
    pub name: String,
    pub instance_url: String,
    pub client_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncHistoryRecord {
    pub id: String,
    pub connection_id: Option<String>,
    pub query_id: Option<String>,
    pub object_name: String,
    pub source_file_path: Option<String>,
    pub status: String,
    pub records_modified: i64,
    pub records_inserted: i64,
    pub records_deleted: i64,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub error_summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportHistoryRecord {
    pub id: String,
    pub query_id: Option<String>,
    pub connection_id: Option<String>,
    pub file_path: String,
    pub format: String,
    pub record_count: Option<i64>,
    pub exported_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub connection_id: Option<String>,
    pub soql_text: String,
    pub object_name: Option<String>,
    pub last_run: Option<i64>,
    pub last_record_count: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConnectionInput {
    pub id: String,
    pub name: Option<String>,
    pub instance_url: Option<String>,
    pub client_id: Option<String>,
}
