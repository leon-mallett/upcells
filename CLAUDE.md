# Upcells — Project Guide

## What this is

Upcells is a commercial desktop app (macOS + Windows) for Salesforce data management. Users connect to Salesforce orgs, query data into xlsx/csv, edit locally in any spreadsheet app, and push changes back with a diff preview. Built with Tauri 2 (Rust backend + React frontend).

**Company:** Mallmont
**Repo:** github.com/leon-mallett/upcells
**Identifier:** com.upcells.app

## Quick start

```bash
npm install          # frontend deps
npm run dev          # starts Vite + Tauri dev (hot-reload)
npm run typecheck    # TS type checking (no emit)
npm run build:mac    # release: universal macOS DMG
npm run build:win    # release: Windows MSI
```

Rust deps are compiled automatically by `tauri dev` / `tauri build`. No separate `cargo build` needed.

Set `VITE_SKIP_LICENSE=true` in `.env` to bypass the license gate during development.

## Architecture

```
src-tauri/src/          Rust backend (Tauri commands)
├── commands/           #[tauri::command] handlers grouped by domain
│   ├── connections.rs  OAuth, org stats
│   ├── queries.rs      SOQL execution, saved query CRUD, bundle export/import
│   ├── export.rs       xlsx/csv file writing with action columns + picklist validation
│   ├── sync.rs         File reading, diff computation, sync execution
│   ├── admin.rs        Field population, duplicates, ownership analysis
│   └── license.rs      Keygen activation, status check, deactivation
├── salesforce/
│   ├── auth.rs         OAuth 2.0 PKCE flow (port 7878 loopback)
│   ├── rest_api.rs     SOQL, describe, limits, composite create/update
│   └── types.rs        SObjectField, QueryResult, etc.
├── db/                 SQLite (WAL mode) — connections, queries, history
├── keychain/           OS keychain via `keyring` — consolidated TokenBundle per connection
├── export/             rust_xlsxwriter + csv writing with metadata/picklist sheets
├── import/             calamine for xlsx, csv crate for csv, date locale handling
├── sync/               Diff engine, action column processing (Feed/Note/Task/Call/Event)
├── license/            Keygen API client, offline grace period (7-day cached token)
├── error.rs            AppError with typed codes (DB_ERROR, AUTH_ERROR, etc.)
├── lib.rs              Tauri app entry, state management, command registration
└── main.rs             Calls upcells_lib::run()

src/                    React frontend (Vite + TypeScript)
├── pages/              Route-level components
│   ├── MainApp.tsx     TanStack Router (hash history): /dashboard, /data, /update, /history, /admin, /settings
│   ├── LicensePage.tsx Marketing page + key activation (shown before MainApp when unlicensed)
│   ├── DashboardPage   Stats, org health, onboarding checklist
│   ├── QueriesPage     Object/field picker, filters, SOQL builder, export
│   ├── ImportPage      Drag-drop file, diff preview, sync execution
│   ├── HistoryPage     Unified export + sync timeline
│   ├── AdminPage       Field population, duplicates, ownership (behind toggle)
│   └── SettingsPage    Orgs, saved queries, preferences, license, about/updater
├── components/
│   ├── layout/         Sidebar, AppShell, CommandPalette (Cmd+K), UpcellsLogo
│   ├── queries/        ResultsTable (sort, search, resize, pagination)
│   ├── connections/    ConnectionForm, SessionExpiredBanner
│   ├── dashboard/      GettingStartedCard (5-step onboarding)
│   └── ui/             shadcn/ui primitives
├── hooks/              React Query wrappers: useQueries, useConnections, useExport, useSync, useLicense
├── stores/             Zustand + localStorage: theme, dateFormat, adminMode, connections, ui
├── lib/
│   ├── tauri-commands.ts  Typed invoke() wrappers for all Rust commands
│   └── validators.ts     Zod schemas (connection form, license key)
└── App.tsx             License gate → MainApp or LicensePage

worker/                 Cloudflare Worker (Polar webhook → Keygen licence creation)
├── index.js            Webhook handler with HMAC-SHA256 verification
└── wrangler.toml       Worker config
```

## Key patterns

### Tauri 2 camelCase convention
JS must pass **camelCase** keys to `invoke()`. Tauri auto-converts to snake_case for Rust. The `tauri-commands.ts` file handles this.

### Serde field renaming
Salesforce returns `"type"` as a field key. Our `SObjectField` uses:
```rust
#[serde(rename(deserialize = "type", serialize = "field_type"))]
```
So Rust deserializes from SF's `type` but serializes as `field_type` for the frontend.

### OAuth flow
PKCE flow using a fixed loopback on port 7878. The callback URL is `http://localhost:7878/callback`. Uses `tokio::select!` for cancel/timeout handling. Browser-based — opens the user's default browser.

### Keychain storage
Single JSON `TokenBundle` per connection (access_token + refresh_token + expiry_epoch). Service name: `com.upcells.app`. Silent migration from legacy per-field items.

### Export round-trip
1. Export writes xlsx/csv with an `[Upcells]` metadata sheet containing field types
2. User edits in Excel/Numbers
3. Import reads the file back, using metadata for type-aware parsing
4. Diff engine compares against original query results
5. Action columns (`[Upcells] Feed Post`, `[Upcells] Note`, etc.) trigger SF record creation

### Date handling
Excel stores dates as serial numbers (days since 1899-12-30). The import path detects these and converts back. Users choose date locale (ISO/International/US) in Settings to resolve DD/MM vs MM/DD ambiguity.

### Licensing
- **Keygen.sh**: Device-locked licenses, machine fingerprint stored in SQLite, 7-day offline grace
- **Polar.sh**: Payment processor (merchant of record)
- **Webhook flow**: Polar order.created → Cloudflare Worker → Keygen API creates license → optional Resend email

### Saved query bundles
Format `"upcells-queries-v1"` (backward compat reads `"cells-queries-"`). Exported as JSON files, importable by other users.

## Environment variables

See `.env.example` for full documentation. Key ones:
- `VITE_SKIP_LICENSE` — `true` for dev, absent/`false` for release
- `VITE_KEYGEN_ACCOUNT_ID` — Keygen account ID
- `VITE_KEYGEN_PRODUCT_ID` — Keygen product ID

## Gotchas

- `cargo check` will fail on `frontendDist: "../dist"` if you haven't built the frontend first — this is expected, not a real error.
- The CSP in `tauri.conf.json` must include any new external domains you connect to.
- Picklist data validation in xlsx uses a hidden `Picklists` sheet when the value list exceeds 255 chars.
- Composite API batches are capped at 200 records per request (Salesforce limit).
- The updater `pubkey` in `tauri.conf.json` is empty — needs `npx tauri signer generate` before first release.

## Project status (as of 2026-05-22)

The app is **feature-complete for v1**. All core functionality is built and working:
Salesforce OAuth, query builder with related fields, export (xlsx/csv with picklist validation + action columns), import/diff/sync, dashboard with org stats, history timeline, admin tools (field population, duplicates, ownership), license gate, command palette (Cmd+K), auto-updater UI, and the Cloudflare Worker for purchase webhooks.

### Keygen.sh licensing credentials

- Account ID: `0e0f6c53-7cca-45b6-a364-996fd2808e6e`
- Product ID: `4069d710-e842-4cba-97bb-905086006c05`
- Policy ID: `9681054c-b8f5-403d-803e-abbf3fd95b1b`
- Policy: "Standard" — floating, max 3 machines, ED25519

### Pre-launch checklist (blocked on external actions)

1. **Apple Developer enrollment** — waiting for Apple approval; needed for macOS code signing + notarisation
2. **Deploy Cloudflare Worker** — code is in `worker/`. Steps: `npx wrangler deploy`, set secrets (`KEYGEN_ACCOUNT_ID`, `KEYGEN_ADMIN_TOKEN`, `KEYGEN_POLICY_ID`, `POLAR_WEBHOOK_SECRET`), then configure the worker URL as the webhook endpoint in the Polar dashboard
3. **Updater signing keypair** — run `npx tauri signer generate` and add the pubkey to `tauri.conf.json` (currently empty)
4. **Resend email setup** — optional, for automatic licence key delivery after purchase
5. **First production build** — `npm run build:mac` once Apple cert is ready
6. **Marketing website** — upcells.app, being built separately

### Known dependency advisories

- **postcss** — _Resolved 2026-06-27._ Updated 8.5.8 → 8.5.15, clearing the moderate XSS advisory (GHSA-qx2v-qp2m-jg93). Same audit pass also cleared `vite` 6.4.2 → 6.4.3 (high, GHSA-v6wh / GHSA-fx2h) and `@babel/core` 7.29.0 → 7.29.7 (low, GHSA-4x5r). `npm audit` is clean. Note: `npm audit fix` rewrites the lockfile but can leave `node_modules` stale (and `npm audit` reads the lockfile, not disk) — re-run `npm ci` after a fix to actually sync installed files.

<!-- SECURITY-MD-INTEGRATION-START -->
## Supply Chain Security Protocol

This project includes a `SECURITY.md` file at the repository root which defines mandatory protocols for defending against supply chain attacks targeting npm, Swift Package Manager, Cargo, CocoaPods, pip, and other package ecosystems.

**Required behaviour for every session:**

- **Before installing or updating ANY dependency**, read `SECURITY.md` and follow its protocols.
- **State the exact package name and version** you intend to install before running any install command.
- **Flag any package version released within the last 72 hours** and require explicit user confirmation before installing.
- **Never modify** `.env*`, shell startup files (`.bashrc`, `.zshrc`, etc.), git hooks, CI/CD configs, AI assistant config directories (`.claude/`, `.cursor/`), or lockfiles (without showing a diff first) without explicit approval.
- **Stop and alert** if you see suspicious `postinstall`/`preinstall`/`prepare` scripts, unexpected files in AI assistant config directories, sudden major version bumps with no changelog, obfuscated code in dependencies, or unfamiliar new dependencies that appeared without explicit user request.
- **Prefer lockfile-respecting commands**: `npm ci` over `npm install`, `cargo build --locked`, etc.

For full details and the current threat landscape, read `SECURITY.md` at the project root.
<!-- SECURITY-MD-INTEGRATION-END -->
