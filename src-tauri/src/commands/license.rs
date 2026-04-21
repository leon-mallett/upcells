use crate::db::DbConnection;
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::license::{self, LicenseInfo};

/// Returns the machine fingerprint (a stable UUID stored in app_config).
/// Generated on first call and persisted so it survives across app launches.
#[tauri::command]
pub async fn get_machine_fingerprint(db: tauri::State<'_, DbConnection>) -> AppResult<String> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;

    if let Some(fp) = crate::db::get_config(&conn, "machine_fingerprint") {
        return Ok(fp);
    }

    // Generate and persist a new fingerprint
    let fp = uuid::Uuid::new_v4().to_string();
    crate::db::set_config(&conn, "machine_fingerprint", &fp)
        .map_err(|e| AppError::db(e.to_string()))?;

    Ok(fp)
}

/// Activates a license key on this machine via the Keygen API.
#[tauri::command]
pub async fn activate_license(
    db: tauri::State<'_, DbConnection>,
    license_key: String,
    account_id: String,
    product_id: String,
) -> AppResult<LicenseInfo> {
    let fingerprint = get_machine_fingerprint(db).await?;

    let hostname = get_machine_name();
    license::activate(&account_id, &product_id, &license_key, &fingerprint, &hostname).await
}

/// Checks the current license status (offline-first with 7-day grace).
#[tauri::command]
pub async fn check_license_status(
    db: tauri::State<'_, DbConnection>,
    account_id: String,
    product_id: String,
) -> AppResult<LicenseInfo> {
    let fingerprint = get_machine_fingerprint(db).await?;
    license::check_license(&account_id, &product_id, &fingerprint).await
}

/// Deactivates the current machine and clears stored credentials.
#[tauri::command]
pub async fn deactivate_license() -> AppResult<()> {
    keychain::delete_license_token()?;
    keychain::delete_secret("license:key")?;
    Ok(())
}

/// Returns whether a license is currently stored (for UI gating on startup).
/// Does NOT validate — use check_license_status for that.
#[tauri::command]
pub async fn has_stored_license() -> AppResult<bool> {
    Ok(keychain::get_license_key().is_ok())
}

fn get_machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Upcells".to_string())
}
