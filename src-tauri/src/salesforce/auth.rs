use crate::db::DbConnection;
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::salesforce::types::TokenResponse;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SF_TOKEN_PATH: &str = "/services/oauth2/token";

// ── PKCE helpers ──────────────────────────────────────────────────────────────

fn generate_code_verifier() -> String {
    let mut bytes = vec![0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

// ── OAuth flow ─────────────────────────────────────────────────────────────────

/// Starts a local loopback HTTP server, opens the Salesforce OAuth page in the
/// system browser, waits for the redirect callback, exchanges the code for
/// tokens, and stores them in the OS keychain.
///
/// Returns the username on success.
pub async fn start_oauth_flow(
    app: &tauri::AppHandle,
    db: &DbConnection,
    connection_id: &str,
    instance_url: &str,
    client_id: &str,
    cancel_handle: &crate::OAuthCancelHandle,
) -> AppResult<String> {
    let code_verifier = generate_code_verifier();
    let challenge = code_challenge(&code_verifier);

    // Fixed port — must match the Callback URL registered in the Salesforce
    // Connected App exactly: http://localhost:7878/callback
    const CALLBACK_PORT: u16 = 7878;
    let listener = TcpListener::bind(format!("127.0.0.1:{}", CALLBACK_PORT))
        .await
        .map_err(|e| AppError::auth(format!(
            "Could not start authentication: port {} is already in use. \
             Wait a moment and try again, or restart Upcells. ({})",
            CALLBACK_PORT, e
        )))?;

    let redirect_uri = format!("http://localhost:{}/callback", CALLBACK_PORT);

    let auth_url = format!(
        "{}/services/oauth2/authorize?response_type=code&client_id={}&redirect_uri={}&code_challenge={}&code_challenge_method=S256",
        instance_url.trim_end_matches('/'),
        urlencoding(client_id),
        urlencoding(&redirect_uri),
        challenge
    );

    // Register a cancel channel so the frontend can abort and release the port
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut guard = cancel_handle.lock().map_err(|_| AppError::auth("Cancel handle poisoned"))?;
        *guard = Some(cancel_tx);
    }

    // Emit the URL so the frontend can display it for copying before we open
    // the default browser. The user may want to paste it into a different browser.
    let _ = app.emit("oauth_url_ready", &auth_url);

    // Open in system browser
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| AppError::auth(format!("Failed to open browser: {}", e)))?;

    // Wait for the callback, the cancel signal, or a 2-minute timeout
    let code = tokio::select! {
        result = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            wait_for_callback(listener),
        ) => {
            result
                .map_err(|_| AppError::auth("Authentication timed out. Please try again."))?
                .map_err(|e| AppError::auth(e))?
        }
        _ = cancel_rx => {
            return Err(AppError::auth("Authentication cancelled"));
        }
    };

    // Clear the cancel handle now that we have the code
    {
        let mut guard = cancel_handle.lock().map_err(|_| AppError::auth("Cancel handle poisoned"))?;
        *guard = None;
    }

    // Exchange code for tokens
    let tokens = exchange_code(instance_url, client_id, &code, &code_verifier, &redirect_uri).await?;

    // Persist tokens (no existing refresh to carry — this is first-time OAuth)
    store_tokens(connection_id, &tokens, None)?;

    // Fetch and update username in DB
    let username = fetch_username(instance_url, &tokens.access_token)
        .await
        .unwrap_or_else(|_| "Unknown".to_string());

    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        conn.execute(
            "UPDATE connections SET username = ?1, status = 'connected', updated_at = ?2 WHERE id = ?3",
            rusqlite::params![username, chrono::Utc::now().timestamp(), connection_id],
        )
        .map_err(|e| AppError::db(e.to_string()))?;
    }

    Ok(username)
}

/// Waits for the loopback HTTP callback and extracts the `code` query param.
async fn wait_for_callback(listener: TcpListener) -> Result<String, String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Accept failed: {}", e))?;

    // Read the full HTTP request (may arrive in multiple reads)
    let mut buf = vec![0u8; 8192];
    let mut total = 0;
    loop {
        match stream.read(&mut buf[total..]).await {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                // Stop once we have the request line (first blank line = end of headers)
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if total >= buf.len() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let request = String::from_utf8_lossy(&buf[..total]);

    // Build a complete HTML response with Content-Length so browsers render it
    let body = concat!(
        "<!doctype html><html><head>",
        "<meta charset='utf-8'>",
        "<title>Upcells — Authenticated</title>",
        "<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;",
        "justify-content:center;height:100vh;margin:0;background:#f8fafc;}",
        ".card{text-align:center;padding:2rem;border-radius:12px;",
        "background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08);}",
        "h2{margin:0 0 .5rem;color:#1e293b;}p{margin:0;color:#64748b;}</style>",
        "</head><body><div class='card'>",
        "<h2>Authentication successful</h2>",
        "<p>You can close this tab and return to Upcells.</p>",
        "</div></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    // Flush and close the write side so the browser receives the full response
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;

    // Parse the GET line: "GET /callback?code=...&state=... HTTP/1.1"
    let first_line = request.lines().next().unwrap_or_default();
    let path = first_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default();

    if path.contains("error=") {
        return Err(format!("Salesforce returned an error: {}", path));
    }

    let code = path
        .split('?')
        .nth(1)
        .unwrap_or_default()
        .split('&')
        .find(|s| s.starts_with("code="))
        .and_then(|s| s.strip_prefix("code="))
        .map(url_decode)
        .ok_or_else(|| "No code in callback".to_string())?;

    Ok(code)
}

/// Exchanges an authorisation code for access + refresh tokens.
async fn exchange_code(
    instance_url: &str,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> AppResult<TokenResponse> {
    let client = reqwest::Client::new();
    let token_url = format!("{}{}", instance_url.trim_end_matches('/'), SF_TOKEN_PATH);

    let mut params = HashMap::new();
    params.insert("grant_type", "authorization_code");
    params.insert("client_id", client_id);
    params.insert("code", code);
    params.insert("redirect_uri", redirect_uri);
    params.insert("code_verifier", verifier);

    let resp = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::auth(format!("Token exchange request failed: {}", e)))?;

    if resp.status().is_success() {
        resp.json::<TokenResponse>()
            .await
            .map_err(|e| AppError::auth(format!("Token parse failed: {}", e)))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(AppError::auth(format!("Token exchange failed: {}", body)))
    }
}

/// Stores tokens from a TokenResponse as a single consolidated keychain
/// bundle. `carry_refresh` lets the caller pass through a refresh token they
/// already have in memory (e.g. the one they just used to refresh) so we
/// avoid an extra keychain read just to preserve it when Salesforce's
/// response doesn't include a new refresh token.
fn store_tokens(
    connection_id: &str,
    tokens: &TokenResponse,
    carry_refresh: Option<&str>,
) -> AppResult<()> {
    let expiry = tokens
        .issued_at
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .map(|ms| ms / 1000 + tokens.expires_in.unwrap_or(7200) as i64)
        .unwrap_or_else(|| chrono::Utc::now().timestamp() + 7200);

    let refresh = tokens
        .refresh_token
        .clone()
        .or_else(|| carry_refresh.map(String::from));

    let bundle = keychain::TokenBundle {
        access_token: tokens.access_token.clone(),
        refresh_token: refresh,
        expiry_epoch: Some(expiry),
    };
    keychain::store_tokens(connection_id, &bundle)
}

/// Refreshes the access token using the stored refresh token.
/// Refreshes the access token. The caller provides the in-memory refresh
/// token so this path doesn't re-read the keychain (avoiding an extra prompt
/// on dev builds with unstable code signatures).
async fn refresh_with(
    db: &DbConnection,
    connection_id: &str,
    instance_url: &str,
    client_id: &str,
    refresh: &str,
) -> AppResult<String> {
    let client = reqwest::Client::new();
    let token_url = format!("{}{}", instance_url.trim_end_matches('/'), SF_TOKEN_PATH);

    let mut params = HashMap::new();
    params.insert("grant_type", "refresh_token");
    params.insert("client_id", client_id);
    params.insert("refresh_token", refresh);

    let resp = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::auth(format!("Refresh request failed: {}", e)))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        // Refresh failed — mark connection as needing re-auth
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let _ = conn.execute(
            "UPDATE connections SET status = 'error', updated_at = ?1 WHERE id = ?2",
            rusqlite::params![chrono::Utc::now().timestamp(), connection_id],
        );
        return Err(AppError::auth(format!("Token refresh failed: {}", body)));
    }

    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|e| AppError::auth(format!("Refresh parse failed: {}", e)))?;

    // Preserve the existing refresh token if SF didn't reissue one
    store_tokens(connection_id, &tokens, Some(refresh))?;

    Ok(tokens.access_token)
}

/// Returns a valid access token, refreshing if it will expire within 5 minutes.
///
/// This is the hot path — it reads the keychain exactly once per call, so
/// users see at most one Keychain prompt per cold start (rather than the
/// 2–3 they used to get from the old per-field storage).
pub async fn ensure_valid_token(
    db: &DbConnection,
    connection_id: &str,
) -> AppResult<(String, String)> {
    // Get connection metadata from DB
    let (instance_url, client_id) = {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        conn.query_row(
            "SELECT instance_url, client_id FROM connections WHERE id = ?1",
            rusqlite::params![connection_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|e| AppError::db(e.to_string()))
        .and_then(|(iu, cid)| {
            let iu = iu.ok_or_else(|| AppError::auth("No instance URL stored"))?;
            let cid = cid.ok_or_else(|| AppError::auth("No client ID stored"))?;
            Ok((iu, cid))
        })?
    };

    // Single keychain read — pull access + refresh + expiry in one go.
    let bundle = keychain::get_tokens(connection_id)?;
    let now = chrono::Utc::now().timestamp();
    let expiring_soon = bundle.expiry_epoch.map(|e| e - now < 300).unwrap_or(true);

    let access_token = if expiring_soon {
        let refresh = bundle.refresh_token.ok_or_else(|| {
            AppError::auth("No refresh token stored — please re-authenticate the connection")
        })?;
        refresh_with(db, connection_id, &instance_url, &client_id, &refresh).await?
    } else {
        bundle.access_token
    };

    Ok((access_token, instance_url))
}

/// Fetches the logged-in username from the Salesforce /userinfo endpoint.
async fn fetch_username(instance_url: &str, access_token: &str) -> AppResult<String> {
    let client = reqwest::Client::new();
    let url = format!("{}/services/oauth2/userinfo", instance_url.trim_end_matches('/'));

    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| AppError::api(e.to_string()))?;

    let info: crate::salesforce::types::UserInfoResponse =
        resp.json().await.map_err(|e| AppError::api(e.to_string()))?;

    Ok(info
        .preferred_username
        .or(info.email)
        .or(info.name)
        .unwrap_or_else(|| "Unknown".to_string()))
}

// ── URL helpers ───────────────────────────────────────────────────────────────

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn url_decode(s: &str) -> String {
    url::form_urlencoded::parse(format!("x={}", s).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| s.to_string())
}
