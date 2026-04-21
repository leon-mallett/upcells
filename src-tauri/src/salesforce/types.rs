use serde::{Deserialize, Serialize};

// ── Salesforce object / field describe ────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SObjectListItem {
    pub name: String,
    pub label: String,
    pub queryable: bool,
}

#[derive(Debug, Deserialize)]
pub struct GlobalDescribeResponse {
    pub sobjects: Vec<SObjectListItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PicklistValue {
    pub value: String,
    pub label: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SObjectField {
    pub name: String,
    pub label: String,
    /// Deserialise from the Salesforce key "type"; serialise as "field_type" for the frontend.
    #[serde(rename(deserialize = "type", serialize = "field_type"))]
    pub field_type: String,
    pub filterable: bool,
    pub sortable: bool,
    pub nillable: bool,
    #[serde(default)]
    pub updateable: bool,
    #[serde(default)]
    pub createable: bool,
    #[serde(
        default,
        rename(deserialize = "restrictedPicklist", serialize = "restricted_picklist")
    )]
    pub restricted_picklist: bool,
    #[serde(
        default,
        rename(deserialize = "picklistValues", serialize = "picklist_values")
    )]
    pub picklist_values: Vec<PicklistValue>,
    /// For reference (lookup) fields, the relationship name used to traverse
    /// to the parent record in SOQL. For `Opportunity.AccountId` this is
    /// `"Account"`, enabling queries like `SELECT Account.Name FROM Opportunity`.
    #[serde(
        default,
        rename(deserialize = "relationshipName", serialize = "relationship_name")
    )]
    pub relationship_name: Option<String>,
    /// The SObject type(s) this reference points to. For polymorphic lookups
    /// (Task.Who → Contact or Lead) this will have more than one entry.
    #[serde(
        default,
        rename(deserialize = "referenceTo", serialize = "reference_to")
    )]
    pub reference_to: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DescribeResponse {
    pub name: String,
    pub label: String,
    pub queryable: bool,
    pub fields: Vec<SObjectField>,
}

// ── Org limits (DailyApiRequests etc.) ────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LimitEntry {
    #[serde(rename = "Max")]
    pub max: u64,
    #[serde(rename = "Remaining")]
    pub remaining: u64,
}

/// Partial view of the Salesforce `/limits/` endpoint. SF returns ~30 limit
/// categories; we only deserialise the one we need.
#[derive(Debug, Deserialize)]
pub struct LimitsResponse {
    #[serde(rename = "DailyApiRequests")]
    pub daily_api_requests: Option<LimitEntry>,
}

/// Returned by the execute_query command.
#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    /// Total records matching the query in Salesforce (may exceed fetched_count if no LIMIT).
    pub total_size: u64,
    /// Number of records actually returned.
    pub fetched_count: usize,
    pub records: Vec<serde_json::Value>,
    /// Column names derived from the first record (excluding the `attributes` key).
    pub columns: Vec<String>,
}

// ── Auth / token types ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub instance_url: String,
    pub id: String,
    pub token_type: String,
    pub issued_at: Option<String>,
    pub expires_in: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TokenErrorResponse {
    pub error: String,
    pub error_description: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ApiVersionsResponse(pub Vec<ApiVersion>);

#[derive(Debug, Deserialize, Serialize)]
pub struct ApiVersion {
    pub label: String,
    pub url: String,
    pub version: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SoqlResponse {
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    pub done: bool,
    pub records: Vec<serde_json::Value>,
    #[serde(rename = "nextRecordsUrl")]
    pub next_records_url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UserInfoResponse {
    pub name: Option<String>,
    pub email: Option<String>,
    pub preferred_username: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub success: bool,
    pub username: Option<String>,
    pub api_versions: Vec<String>,
    pub message: String,
}
