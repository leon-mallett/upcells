use crate::db::DbConnection;
use crate::error::{AppError, AppResult};
use crate::salesforce::auth::ensure_valid_token;
use crate::salesforce::types::{self, ConnectionTestResult, SoqlResponse};

const SF_API_VERSION: &str = "v62.0";

fn api_base(instance_url: &str) -> String {
    format!(
        "{}/services/data/{}",
        instance_url.trim_end_matches('/'),
        SF_API_VERSION
    )
}

/// Verifies that the stored credentials work by calling the root API endpoint.
pub async fn test_connection(db: &DbConnection, connection_id: &str) -> AppResult<ConnectionTestResult> {
    let (access_token, instance_url) = ensure_valid_token(db, connection_id).await?;

    let client = reqwest::Client::new();
    let url = format!(
        "{}/",
        instance_url.trim_end_matches('/')
    );

    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::api(format!("Connection test request failed: {}", e)))?;

    if resp.status().is_success() {
        let versions: Vec<crate::salesforce::types::ApiVersion> = resp
            .json()
            .await
            .map_err(|e| AppError::api(e.to_string()))?;

        let version_labels: Vec<String> = versions.iter().map(|v| v.version.clone()).collect();

        Ok(ConnectionTestResult {
            success: true,
            username: None, // Username already in DB after OAuth
            api_versions: version_labels,
            message: "Connection successful".to_string(),
        })
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Ok(ConnectionTestResult {
            success: false,
            username: None,
            api_versions: vec![],
            message: format!("Connection failed ({}): {}", status, body),
        })
    }
}

/// Executes a SOQL query and returns all records (following pagination) plus
/// the `totalSize` from the first page (total matching records in Salesforce).
pub async fn execute_soql(
    db: &DbConnection,
    connection_id: &str,
    soql: &str,
) -> AppResult<(Vec<serde_json::Value>, u64)> {
    let (access_token, instance_url) = ensure_valid_token(db, connection_id).await?;
    let client = reqwest::Client::new();

    let mut records: Vec<serde_json::Value> = Vec::new();
    let mut total_size: u64 = 0;
    let mut first_page = true;
    let mut url_to_fetch = format!(
        "{}/query?q={}",
        api_base(&instance_url),
        urlencoding(soql)
    );

    loop {
        let resp = client
            .get(&url_to_fetch)
            .bearer_auth(&access_token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| AppError::api(format!("SOQL request failed: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::api(format!("SOQL failed ({}): {}", status, body)));
        }

        let page: SoqlResponse = resp
            .json()
            .await
            .map_err(|e| AppError::api(format!("SOQL response parse failed: {}", e)))?;

        if first_page {
            total_size = page.total_size;
            first_page = false;
        }

        records.extend(page.records);

        match page.next_records_url {
            Some(next) if !page.done => {
                url_to_fetch = format!("{}{}", instance_url.trim_end_matches('/'), next);
            }
            _ => break,
        }
    }

    Ok((records, total_size))
}

/// Returns all queryable SObject types from the org.
pub async fn list_sobjects(
    db: &DbConnection,
    connection_id: &str,
) -> AppResult<Vec<types::SObjectListItem>> {
    let (access_token, instance_url) = ensure_valid_token(db, connection_id).await?;
    let client = reqwest::Client::new();
    let url = format!("{}/sobjects/", api_base(&instance_url));

    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::api(format!("List objects request failed: {}", e)))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::api(format!("List objects failed: {}", body)));
    }

    let describe: types::GlobalDescribeResponse = resp
        .json()
        .await
        .map_err(|e| AppError::api(format!("Global describe parse failed: {}", e)))?;

    Ok(describe.sobjects.into_iter().filter(|o| o.queryable).collect())
}

/// Fetches the org's API limits (daily request quota, etc.).
pub async fn get_limits(
    db: &DbConnection,
    connection_id: &str,
) -> AppResult<types::LimitsResponse> {
    let (access_token, instance_url) = ensure_valid_token(db, connection_id).await?;
    let client = reqwest::Client::new();
    let url = format!("{}/limits/", api_base(&instance_url));

    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::api(format!("Limits request failed: {}", e)))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::api(format!("Limits failed: {}", body)));
    }

    resp.json::<types::LimitsResponse>()
        .await
        .map_err(|e| AppError::api(format!("Limits parse failed: {}", e)))
}

/// Returns field metadata for a single SObject type.
pub async fn describe_object(
    db: &DbConnection,
    connection_id: &str,
    object_name: &str,
) -> AppResult<types::DescribeResponse> {
    let (access_token, instance_url) = ensure_valid_token(db, connection_id).await?;
    let client = reqwest::Client::new();
    let url = format!(
        "{}/sobjects/{}/describe/",
        api_base(&instance_url),
        object_name
    );

    let resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::api(format!("Describe request failed: {}", e)))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::api(format!("Describe failed: {}", body)));
    }

    resp.json::<types::DescribeResponse>()
        .await
        .map_err(|e| AppError::api(format!("Describe parse failed: {}", e)))
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

// ── Composite SObject Collections API ─────────────────────────────────────────
//
// These wrap POST/PATCH /services/data/vXX.X/composite/sobjects/
// which accept up to 200 records per call.
//
// Request body shape: {"allOrNone": false, "records": [
//   {"attributes": {"type": "Account"}, "Name": "Acme", ...},
// ]}
//
// Response shape: [{"id": "001...", "success": true, "errors": []}, ...]

/// Per-record result returned by the Composite Collections API.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CompositeRecordResult {
    pub id: Option<String>,
    pub success: bool,
    #[serde(default)]
    pub errors: Vec<CompositeErrorDetail>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CompositeErrorDetail {
    #[serde(rename = "statusCode")]
    pub status_code: String,
    pub message: String,
    #[serde(default)]
    pub fields: Vec<String>,
}

const COMPOSITE_CHUNK_SIZE: usize = 200;

/// Creates records using the SObject Collections POST endpoint, chunked to
/// 200 records per call. `allOrNone=false` so partial success is possible.
pub async fn composite_create(
    db: &DbConnection,
    connection_id: &str,
    object_name: &str,
    records: Vec<serde_json::Map<String, serde_json::Value>>,
) -> AppResult<Vec<CompositeRecordResult>> {
    composite_write(db, connection_id, object_name, records, false).await
}

/// Updates records using the SObject Collections PATCH endpoint. Each record
/// MUST include an `Id` field (we don't enforce this — caller's job).
pub async fn composite_update(
    db: &DbConnection,
    connection_id: &str,
    object_name: &str,
    records: Vec<serde_json::Map<String, serde_json::Value>>,
) -> AppResult<Vec<CompositeRecordResult>> {
    composite_write(db, connection_id, object_name, records, true).await
}

async fn composite_write(
    db: &DbConnection,
    connection_id: &str,
    object_name: &str,
    records: Vec<serde_json::Map<String, serde_json::Value>>,
    is_update: bool,
) -> AppResult<Vec<CompositeRecordResult>> {
    if records.is_empty() {
        return Ok(vec![]);
    }

    let (access_token, instance_url) = ensure_valid_token(db, connection_id).await?;
    let client = reqwest::Client::new();
    let url = format!("{}/composite/sobjects/", api_base(&instance_url));

    // Attach the `attributes.type` field required by Salesforce to every record
    let tagged_records: Vec<serde_json::Value> = records
        .into_iter()
        .map(|mut r| {
            let mut attrs = serde_json::Map::new();
            attrs.insert(
                "type".to_string(),
                serde_json::Value::String(object_name.to_string()),
            );
            r.insert("attributes".to_string(), serde_json::Value::Object(attrs));
            serde_json::Value::Object(r)
        })
        .collect();

    let mut all_results: Vec<CompositeRecordResult> = Vec::with_capacity(tagged_records.len());

    for chunk in tagged_records.chunks(COMPOSITE_CHUNK_SIZE) {
        let body = serde_json::json!({
            "allOrNone": false,
            "records": chunk,
        });

        let req = if is_update {
            client.patch(&url)
        } else {
            client.post(&url)
        };

        let resp = req
            .bearer_auth(&access_token)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| AppError::api(format!("Composite request failed: {}", e)))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::api(format!(
                "Composite {} failed ({}): {}",
                if is_update { "update" } else { "create" },
                status,
                text
            )));
        }

        let chunk_results: Vec<CompositeRecordResult> = resp
            .json()
            .await
            .map_err(|e| AppError::api(format!("Composite response parse failed: {}", e)))?;

        all_results.extend(chunk_results);
    }

    Ok(all_results)
}
