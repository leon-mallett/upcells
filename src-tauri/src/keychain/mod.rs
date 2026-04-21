use crate::error::{AppError, AppResult};
use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.upcells.app";

fn entry(account: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, account).map_err(|e| AppError::keychain(e.to_string()))
}

pub fn store_secret(account: &str, secret: &str) -> AppResult<()> {
    entry(account)?
        .set_password(secret)
        .map_err(|e| AppError::keychain(e.to_string()))
}

pub fn get_secret(account: &str) -> AppResult<String> {
    entry(account)?
        .get_password()
        .map_err(|e| AppError::keychain(format!("secret not found for '{}': {}", account, e)))
}

pub fn delete_secret(account: &str) -> AppResult<()> {
    match entry(account)?.delete_credential() {
        Ok(_) => Ok(()),
        // Not found is fine — treat as success
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::keychain(e.to_string())),
    }
}

// ── Consolidated token bundle (one keychain item per connection) ─────────────
//
// macOS Keychain's "Always Allow" ACL is per-item, so storing access_token,
// refresh_token, and token_expiry as three separate items forced users to
// approve three prompts per cold start (or two, depending on which codepath
// runs first). Folding everything into one JSON-encoded item collapses that
// to a single prompt.
//
// (Note: development builds still re-prompt on every restart because the
// keychain ACL is tied to the app's code signature, which changes on each
// unsigned `cargo tauri dev` rebuild. That's resolved by code-signing for
// production builds.)

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TokenBundle {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expiry_epoch: Option<i64>,
}

fn tokens_account(connection_id: &str) -> String {
    format!("{}:tokens", connection_id)
}

pub fn store_tokens(connection_id: &str, bundle: &TokenBundle) -> AppResult<()> {
    let json = serde_json::to_string(bundle)
        .map_err(|e| AppError::keychain(format!("Failed to serialise tokens: {}", e)))?;
    store_secret(&tokens_account(connection_id), &json)
}

/// Reads the consolidated token bundle. If only legacy per-field items exist
/// (from a pre-consolidation install), they're read, combined into a bundle,
/// written back as a single item, and the legacy entries are removed. This
/// is a one-time migration — subsequent reads only hit the single item.
pub fn get_tokens(connection_id: &str) -> AppResult<TokenBundle> {
    if let Ok(json) = get_secret(&tokens_account(connection_id)) {
        return serde_json::from_str(&json)
            .map_err(|e| AppError::keychain(format!("Failed to parse token bundle: {}", e)));
    }

    // Legacy fallback + silent migration
    let legacy_access = format!("{}:access_token", connection_id);
    let legacy_refresh = format!("{}:refresh_token", connection_id);
    let legacy_expiry = format!("{}:token_expiry", connection_id);

    let access = get_secret(&legacy_access)?;
    let refresh = get_secret(&legacy_refresh).ok();
    let expiry = get_secret(&legacy_expiry)
        .ok()
        .and_then(|s| s.parse::<i64>().ok());

    let bundle = TokenBundle {
        access_token: access,
        refresh_token: refresh,
        expiry_epoch: expiry,
    };

    // Best-effort migration: write the new single item, remove the legacy
    // ones. Errors here are non-fatal — on a future cold start we'll just
    // run the migration path again.
    let _ = store_tokens(connection_id, &bundle);
    let _ = delete_secret(&legacy_access);
    let _ = delete_secret(&legacy_refresh);
    let _ = delete_secret(&legacy_expiry);

    Ok(bundle)
}

pub fn delete_all_tokens(connection_id: &str) -> AppResult<()> {
    // New consolidated item
    delete_secret(&tokens_account(connection_id))?;
    // Legacy items, if any still linger from before migration
    let _ = delete_secret(&format!("{}:access_token", connection_id));
    let _ = delete_secret(&format!("{}:refresh_token", connection_id));
    let _ = delete_secret(&format!("{}:token_expiry", connection_id));
    Ok(())
}

// License key storage
pub fn store_license_token(token: &str) -> AppResult<()> {
    store_secret("license:validation_token", token)
}

pub fn get_license_token() -> AppResult<String> {
    get_secret("license:validation_token")
}

pub fn delete_license_token() -> AppResult<()> {
    delete_secret("license:validation_token")
}

pub fn store_license_key(key: &str) -> AppResult<()> {
    store_secret("license:key", key)
}

pub fn get_license_key() -> AppResult<String> {
    get_secret("license:key")
}
