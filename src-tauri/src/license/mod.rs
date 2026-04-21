use crate::error::{AppError, AppResult};
use crate::keychain;
use serde::{Deserialize, Serialize};

const KEYGEN_API_BASE: &str = "https://api.keygen.sh/v1/accounts";
// Grace period: app works offline for this many days without refreshing
const OFFLINE_GRACE_DAYS: i64 = 7;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LicenseStatus {
    Valid,
    Trial,
    Expired,
    Suspended,
    NotActivated,
    NotFound,
    Invalid,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LicenseInfo {
    pub status: LicenseStatus,
    pub key: String,
    pub expiry: Option<String>,
    pub machine_count: Option<u32>,
    pub machine_limit: Option<u32>,
    pub message: String,
}

/// Validates a license key against the Keygen API and activates the current
/// machine. Stores the validation token in the OS keychain on success.
pub async fn activate(
    account_id: &str,
    product_id: &str,
    license_key: &str,
    machine_fingerprint: &str,
    machine_name: &str,
) -> AppResult<LicenseInfo> {
    let client = reqwest::Client::new();

    // Step 1: Validate the key
    let validate_url = format!(
        "{}/{}/licenses/actions/validate-key",
        KEYGEN_API_BASE, account_id
    );

    let body = serde_json::json!({
        "meta": {
            "key": license_key,
            "scope": {
                "product": product_id,
                "fingerprint": machine_fingerprint
            }
        }
    });

    let resp = client
        .post(&validate_url)
        .header("Accept", "application/vnd.api+json")
        .header("Content-Type", "application/vnd.api+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::license(format!("Keygen request failed: {}", e)))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::license(format!("Keygen response parse failed: {}", e)))?;

    let meta = &json["meta"];
    let code = meta["code"].as_str().unwrap_or("UNKNOWN");
    let valid = meta["valid"].as_bool().unwrap_or(false);

    if !valid {
        let message = match code {
            "NO_MACHINES" | "NO_MACHINE" => {
                // Key is valid but not yet activated on this machine — activate it
                activate_machine(account_id, &json, machine_fingerprint, machine_name, license_key)
                    .await?;
                "License activated on this machine".to_string()
            }
            "FINGERPRINT_SCOPE_MISMATCH" => {
                return Err(AppError::license(
                    "This license is already activated on a different machine.",
                ))
            }
            "EXPIRED" => return Err(AppError::license("License has expired. Please renew.")),
            "SUSPENDED" => return Err(AppError::license("License has been suspended.")),
            "NOT_FOUND" => return Err(AppError::license("License key not found.")),
            _ => return Err(AppError::license(format!("License invalid: {}", code))),
        };

        let info = build_license_info(&json, license_key, LicenseStatus::Valid, message);
        persist_license(license_key, &info)?;
        return Ok(info);
    }

    let status = match code {
        "VALID" => LicenseStatus::Valid,
        "EXPIRED" => LicenseStatus::Expired,
        "SUSPENDED" => LicenseStatus::Suspended,
        _ => LicenseStatus::Valid,
    };

    let info = build_license_info(&json, license_key, status, "License is valid".to_string());
    persist_license(license_key, &info)?;

    Ok(info)
}

/// Activates the machine against the license.
async fn activate_machine(
    account_id: &str,
    validate_response: &serde_json::Value,
    fingerprint: &str,
    machine_name: &str,
    license_key: &str,
) -> AppResult<()> {
    let license_id = validate_response["data"]["id"]
        .as_str()
        .ok_or_else(|| AppError::license("Could not extract license ID"))?;

    let client = reqwest::Client::new();
    let url = format!("{}/{}/machines", KEYGEN_API_BASE, account_id);

    let body = serde_json::json!({
        "data": {
            "type": "machines",
            "attributes": {
                "fingerprint": fingerprint,
                "name": machine_name
            },
            "relationships": {
                "license": {
                    "data": { "type": "licenses", "id": license_id }
                }
            }
        }
    });

    let resp = client
        .post(&url)
        .header("Accept", "application/vnd.api+json")
        .header("Content-Type", "application/vnd.api+json")
        .header("Authorization", format!("License {}", license_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::license(format!("Machine activation request failed: {}", e)))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::license(format!(
            "Machine activation failed: {}",
            body
        )));
    }

    Ok(())
}

/// Checks the stored license token. Returns cached info if within grace period,
/// otherwise re-validates online.
pub async fn check_license(
    account_id: &str,
    product_id: &str,
    machine_fingerprint: &str,
) -> AppResult<LicenseInfo> {
    // Try to load cached info from keychain
    if let Ok(cached_json) = keychain::get_license_token() {
        if let Ok(cached) = serde_json::from_str::<CachedLicense>(&cached_json) {
            let age_days =
                (chrono::Utc::now().timestamp() - cached.validated_at) / 86400;

            if age_days < OFFLINE_GRACE_DAYS {
                return Ok(cached.info);
            }
        }
    }

    // Cache expired or not present — re-validate online
    let license_key = keychain::get_license_key()?;
    activate(account_id, product_id, &license_key, machine_fingerprint, "Upcells").await
}

fn build_license_info(
    json: &serde_json::Value,
    key: &str,
    status: LicenseStatus,
    message: String,
) -> LicenseInfo {
    let attrs = &json["data"]["attributes"];
    LicenseInfo {
        status,
        key: key.to_string(),
        expiry: attrs["expiry"].as_str().map(String::from),
        machine_count: None,
        machine_limit: attrs["maxMachines"].as_u64().map(|v| v as u32),
        message,
    }
}

fn persist_license(key: &str, info: &LicenseInfo) -> AppResult<()> {
    keychain::store_license_key(key)?;

    let cached = CachedLicense {
        info: info.clone(),
        validated_at: chrono::Utc::now().timestamp(),
    };
    let json =
        serde_json::to_string(&cached).map_err(|e| AppError::license(e.to_string()))?;
    keychain::store_license_token(&json)?;

    Ok(())
}

#[derive(Serialize, Deserialize)]
struct CachedLicense {
    info: LicenseInfo,
    validated_at: i64,
}
