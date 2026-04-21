use crate::db::{models::Connection, DbConnection};
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::salesforce::{auth as sf_auth, rest_api as sf_api};
use crate::salesforce::types::ConnectionTestResult;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Snapshot of high-level metrics for a single connected org, shown on the
/// dashboard. Each field is `Option` so partial failures (e.g. the user's
/// profile can't see Opportunity) still surface whatever did work.
#[derive(Debug, Serialize, Deserialize)]
pub struct OrgStats {
    pub connection_id: String,
    pub accounts: Option<u64>,
    pub contacts: Option<u64>,
    pub opportunities: Option<u64>,
    pub daily_api_max: Option<u64>,
    pub daily_api_remaining: Option<u64>,
    /// Error messages for any failed sub-request. Empty vec means everything
    /// succeeded.
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn list_connections(db: tauri::State<'_, DbConnection>) -> AppResult<Vec<Connection>> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, instance_url, client_id, username, status, created_at, updated_at, last_tested
             FROM connections ORDER BY name ASC",
        )
        .map_err(|e| AppError::db(e.to_string()))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                connection_type: row.get(2)?,
                instance_url: row.get(3)?,
                client_id: row.get(4)?,
                username: row.get(5)?,
                status: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                last_tested: row.get(9)?,
            })
        })
        .map_err(|e| AppError::db(e.to_string()))?;

    let connections: Result<Vec<_>, _> = rows.collect();
    connections.map_err(|e| AppError::db(e.to_string()))
}

#[tauri::command]
pub async fn create_connection(
    db: tauri::State<'_, DbConnection>,
    name: String,
    instance_url: String,
    client_id: String,
) -> AppResult<Connection> {
    let now = Utc::now().timestamp();
    let id = Uuid::new_v4().to_string();

    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    conn.execute(
        "INSERT INTO connections (id, name, type, instance_url, client_id, status, created_at, updated_at)
         VALUES (?1, ?2, 'salesforce', ?3, ?4, 'untested', ?5, ?6)",
        rusqlite::params![id, name, instance_url, client_id, now, now],
    )
    .map_err(|e| AppError::db(e.to_string()))?;

    Ok(Connection {
        id,
        name,
        connection_type: "salesforce".to_string(),
        instance_url: Some(instance_url),
        client_id: Some(client_id),
        username: None,
        status: "untested".to_string(),
        created_at: now,
        updated_at: now,
        last_tested: None,
    })
}

#[tauri::command]
pub async fn update_connection(
    db: tauri::State<'_, DbConnection>,
    id: String,
    name: Option<String>,
    instance_url: Option<String>,
    client_id: Option<String>,
) -> AppResult<Connection> {
    let now = Utc::now().timestamp();
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;

    if let Some(n) = &name {
        conn.execute(
            "UPDATE connections SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![n, now, id],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }
    if let Some(iu) = &instance_url {
        conn.execute(
            "UPDATE connections SET instance_url = ?1, status = 'untested', updated_at = ?2 WHERE id = ?3",
            rusqlite::params![iu, now, id],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }
    if let Some(cid) = &client_id {
        conn.execute(
            "UPDATE connections SET client_id = ?1, status = 'untested', updated_at = ?2 WHERE id = ?3",
            rusqlite::params![cid, now, id],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }

    conn.query_row(
        "SELECT id, name, type, instance_url, client_id, username, status, created_at, updated_at, last_tested
         FROM connections WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                connection_type: row.get(2)?,
                instance_url: row.get(3)?,
                client_id: row.get(4)?,
                username: row.get(5)?,
                status: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                last_tested: row.get(9)?,
            })
        },
    )
    .map_err(|e| AppError::db(e.to_string()))
}

#[tauri::command]
pub async fn delete_connection(
    db: tauri::State<'_, DbConnection>,
    id: String,
) -> AppResult<()> {
    // Clear tokens from keychain first
    keychain::delete_all_tokens(&id)?;

    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    conn.execute("DELETE FROM connections WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| AppError::db(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub async fn start_salesforce_oauth(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbConnection>,
    cancel_handle: tauri::State<'_, crate::OAuthCancelHandle>,
    connection_id: String,
    instance_url: String,
    client_id: String,
) -> AppResult<String> {
    sf_auth::start_oauth_flow(
        &app,
        &db,
        &connection_id,
        &instance_url,
        &client_id,
        &cancel_handle,
    )
    .await
}

#[tauri::command]
pub async fn cancel_oauth(
    cancel_handle: tauri::State<'_, crate::OAuthCancelHandle>,
) -> AppResult<()> {
    let mut guard = cancel_handle
        .lock()
        .map_err(|_| AppError::auth("Cancel handle poisoned"))?;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
) -> AppResult<ConnectionTestResult> {
    let result = sf_api::test_connection(&db, &connection_id).await?;

    // Update last_tested and status in DB
    let status = if result.success { "connected" } else { "error" };
    let now = Utc::now().timestamp();
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    let _ = conn.execute(
        "UPDATE connections SET status = ?1, last_tested = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![status, now, now, connection_id],
    );

    Ok(result)
}

/// Fetches Account/Contact/Opportunity totals plus the daily API quota for
/// a single org. All four sub-requests are best-effort — a failure on any
/// one is captured in `errors` but the rest of the stats still return.
#[tauri::command]
pub async fn get_org_stats(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
) -> AppResult<OrgStats> {
    let mut errors: Vec<String> = Vec::new();

    // `SELECT COUNT() FROM X` returns an empty records array with the count
    // in `totalSize`, which execute_soql already surfaces as the second
    // tuple element — so we can reuse it directly.
    async fn count(
        db: &DbConnection,
        id: &str,
        object: &str,
    ) -> Result<u64, crate::error::AppError> {
        let soql = format!("SELECT COUNT() FROM {}", object);
        let (_records, total) = sf_api::execute_soql(db, id, &soql).await?;
        Ok(total)
    }

    let accounts = match count(&db, &connection_id, "Account").await {
        Ok(n) => Some(n),
        Err(e) => {
            errors.push(format!("Account count: {}", e.message));
            None
        }
    };
    let contacts = match count(&db, &connection_id, "Contact").await {
        Ok(n) => Some(n),
        Err(e) => {
            errors.push(format!("Contact count: {}", e.message));
            None
        }
    };
    let opportunities = match count(&db, &connection_id, "Opportunity").await {
        Ok(n) => Some(n),
        Err(e) => {
            errors.push(format!("Opportunity count: {}", e.message));
            None
        }
    };

    let (daily_api_max, daily_api_remaining) = match sf_api::get_limits(&db, &connection_id).await {
        Ok(limits) => match limits.daily_api_requests {
            Some(l) => (Some(l.max), Some(l.remaining)),
            None => (None, None),
        },
        Err(e) => {
            errors.push(format!("Limits: {}", e.message));
            (None, None)
        }
    };

    Ok(OrgStats {
        connection_id,
        accounts,
        contacts,
        opportunities,
        daily_api_max,
        daily_api_remaining,
        errors,
    })
}

#[tauri::command]
pub async fn disconnect(
    db: tauri::State<'_, DbConnection>,
    connection_id: String,
) -> AppResult<()> {
    keychain::delete_all_tokens(&connection_id)?;

    let now = Utc::now().timestamp();
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    conn.execute(
        "UPDATE connections SET status = 'untested', username = NULL, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, connection_id],
    )
    .map_err(|e| AppError::db(e.to_string()))?;

    Ok(())
}
