# Salesforce Connected App Setup Guide

This guide walks you through every step required to connect Upcells to a Salesforce org. You will need to complete these steps once per org.

---

## Before You Begin

**You will need:**
- Admin access (System Administrator profile) to your Salesforce org
- A Salesforce org — either a Developer Edition org (free) or a sandbox

**If you don't have a Salesforce org yet:**
1. Go to [developer.salesforce.com/signup](https://developer.salesforce.com/signup)
2. Fill in your details — name, email, username (must be unique across all SF orgs, e.g. `you@upcells-dev.sandbox`)
3. Check your email and activate your account
4. Your org URL will be `https://login.salesforce.com` for Developer Edition, or `https://test.salesforce.com` for sandboxes

---

## Step 1 — Navigate to Connected Apps

1. Log in to your Salesforce org
2. Click the **gear icon** (⚙) in the top-right corner and select **Setup**
3. In the left-hand Quick Find box, type `App Manager`
4. Click **App Manager** under Apps
5. Click **New Connected App** in the top-right of the list

---

## Step 2 — Basic Information

Fill in the following fields:

| Field | Value |
|---|---|
| Connected App Name | `Upcells Desktop` (or any name you like) |
| API Name | Auto-filled from the name — leave as-is |
| Contact Email | Your email address |

---

## Step 3 — Enable OAuth Settings

1. Tick the checkbox **Enable OAuth Settings**
2. A new section will expand

**Callback URL:**
```
http://localhost:7878/callback
```
> This must be entered exactly as shown — including the port number and `/callback` path. Salesforce requires an exact match on the redirect URI. Do not use `https://` here.

**Selected OAuth Scopes** — add these two scopes by selecting them and clicking the Add arrow:
- `Access and manage your data (api)`
- `Perform requests at any time (refresh_token, offline_access)`

Your selected scopes panel should show:
```
api
refresh_token, offline_access
```

**Other settings — set these:**

| Setting | Value |
|---|---|
| Require Secret for Web Server Flow | **Unchecked** (not required for PKCE) |
| Require Secret for Refresh Token Flow | **Unchecked** |
| Enable PKCE Extension for Supported Authorization Flows | **Checked** (if available in your edition) |
| Introspect All Tokens | Leave unchecked |

3. Click **Save**
4. Click **Continue** on the confirmation screen

---

## Step 4 — Wait for Propagation

After saving, Salesforce needs a few minutes to propagate the new Connected App. If you try to authenticate immediately and get an error, wait 2–3 minutes and try again.

---

## Step 5 — Find Your Consumer Key

1. After saving, you are on the Connected App detail page
2. Click **Manage Consumer Details** (you may be asked to verify your identity)
3. Copy the **Consumer Key** — this is a long string starting with `3MVG9...`

> **Keep this key safe.** You will enter it into Upcells when creating a connection. The Consumer Secret is NOT needed for the PKCE flow Upcells uses.

---

## Step 6 — Set OAuth Policies

These settings control who can use the app and how long sessions last.

1. From the Connected App detail page, click **Manage**
2. Click **Edit Policies**

Set the following:

| Policy | Recommended Setting |
|---|---|
| Permitted Users | `All users may self-authorize` (recommended for personal use) or `Admin approved users are pre-authorized` (for org-wide deployment) |
| IP Relaxation | `Relax IP restrictions` — required so desktop users on various networks can authenticate |
| Refresh Token Policy | `Refresh token is valid until revoked` — so you don't need to re-authenticate every few hours |

3. Click **Save**

---

## Step 7 — Set Up Upcells

1. Open Upcells
2. Click **Connections** in the sidebar → **Add connection**
3. Fill in:
   - **Connection name**: anything descriptive (e.g. `My Salesforce Dev Org`)
   - **Instance URL**: your org's URL, e.g. `https://myorg.my.salesforce.com`
     - Developer Edition: `https://login.salesforce.com`
     - Sandbox: `https://test.salesforce.com`
     - Custom domain: `https://yourcompany.my.salesforce.com`
   - **Consumer Key**: the key you copied in Step 5
4. Click **Create connection**
5. On the connection card, click **Authenticate**
6. Your default browser will open the Salesforce login page
7. Log in and click **Allow**
8. The browser will close and Upcells will show **Connected** status with your username

---

## Step 8 — Check User Permissions

The Salesforce user authenticating must have the right permissions to query and update the objects you want to work with.

**Minimum permissions required:**

| Permission | Required For |
|---|---|
| API Enabled | All API access — without this nothing works |
| Read on target objects | Running SOQL queries and exporting |
| Edit on target objects | Syncing changes back to Salesforce |
| View All Data / Modify All Data | Optional: needed if you want to access other users' records |

**Where to check:**
- Setup → Users → [your user] → Permission Sets / Profile
- Or: Setup → Profiles → [your profile] → Object Settings → [Object name]

---

## Common Errors and Fixes

### `error=redirect_uri_mismatch`
**Cause:** The Callback URL in your Connected App does not exactly match `http://localhost:7878/callback`.
**Fix:** Go to Setup → App Manager → [your Connected App] → Edit. Under OAuth Settings, update the Callback URL to exactly `http://localhost:7878/callback`. Save and wait 2–3 minutes for propagation.

### `insufficient_access_rights` / `INSUFFICIENT_ACCESS`
**Cause:** The authenticating user's profile does not have API Enabled, or lacks read/write access to the object you are querying.
**Fix:** Check the user's profile/permission set. Ensure "API Enabled" is ticked.

### `Session expired or invalid`
**Cause:** The access token has expired and the refresh failed (e.g. refresh token was revoked, or the Connected App was deleted/modified).
**Fix:** Click **Authenticate** again in Upcells to get a fresh token.

### Authentication window opens but hangs / no "Connected" status
**Cause:** The browser completed the flow but the loopback server didn't receive the redirect (rare, usually a firewall or AV blocking `localhost`).
**Fix:** Check that your firewall or antivirus isn't blocking incoming connections on localhost. Try disabling it temporarily while authenticating.

### `Connected App not found` or `invalid_client_id`
**Cause:** Either the Consumer Key is wrong, or the Connected App hasn't fully propagated yet (can take up to 10 minutes after creation).
**Fix:** Double-check the Consumer Key (no trailing spaces). If recently created, wait 5–10 minutes and retry.

---

## Sandbox vs Production

| | Developer Edition | Sandbox | Production |
|---|---|---|---|
| Sign-in URL | `login.salesforce.com` | `test.salesforce.com` | Your custom domain or `login.salesforce.com` |
| Connected App | Separate per org | Separate per sandbox | Separate from sandbox |
| API usage limits | Generous for dev | Mirrors production | Org-specific |
| Risk of data loss | None (no real data) | Low (test data) | High — always test in sandbox first |

> **Important:** Always test your queries and sync operations in a sandbox before running them against a production org. Upcells will show you a diff before syncing, but take the time to review it carefully.

---

## Further Reading

- [Salesforce REST API Developer Guide](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/)
- [SOQL and SOSL Reference](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/)
- [Connected Apps Overview](https://help.salesforce.com/s/articleView?id=sf.connected_app_overview.htm)
- [OAuth 2.0 Authorization Code Flow (PKCE)](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_pkce_flow.htm)
- [API Limits](https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_api.htm)
- [Salesforce Inspector browser extension](https://chromewebstore.google.com/detail/salesforce-inspector-relo/hpijlohoihegkfehhibggnkbjhoemldh) — great for exploring object schemas during development
