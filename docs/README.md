# Upcells

A local desktop app for editing API data using spreadsheets.

Connect to Salesforce (or other APIs), pull data into an xlsx/csv file, edit it locally, and push the changes back — reviewed diff by diff.

## Prerequisites

Before running this project, install:

1. **Node.js 20+** — [nodejs.org](https://nodejs.org)
2. **Rust + Cargo** — [rustup.rs](https://rustup.rs)
3. **Tauri prerequisites** for your OS:
   - macOS: Xcode Command Line Tools (`xcode-select --install`)
   - Windows: Microsoft Visual Studio C++ Build Tools + WebView2 (usually pre-installed on Windows 11)

Full Tauri prerequisites guide: [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)

## Getting Started

```bash
# Install JS dependencies
npm install

# Start the development app
npm run dev
```

The first `npm run dev` will trigger a Rust compilation which takes a few minutes.

## Building for Distribution

```bash
npm run build
```

Outputs:
- macOS: `src-tauri/target/release/bundle/dmg/Upcells_*.dmg`
- Windows: `src-tauri/target/release/bundle/msi/Upcells_*.msi`

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

For local development without a license, set:
```
VITE_SKIP_LICENSE=true
```

## Salesforce Setup

See [docs/setup/salesforce-connected-app.md](setup/salesforce-connected-app.md) for the complete guide to creating a Connected App and connecting Upcells to your Salesforce org.

## Architecture

- **Frontend**: React 18 + TypeScript, Tailwind CSS, shadcn/ui, TanStack Router + Query, Zustand
- **Backend**: Rust (Tauri 2), SQLite (rusqlite), OS keychain (keyring crate)
- **Salesforce**: OAuth 2.0 PKCE with loopback callback, REST API v62.0
- **Licensing**: Keygen.sh (device-locked, offline-capable)
- **Payments**: Polar.sh (merchant-of-record, handles global tax)

## Project Structure

```
src/                  React/TypeScript frontend
src-tauri/            Rust/Tauri backend
  src/
    commands/         Tauri commands (invoked from frontend)
    db/               SQLite layer + migrations
    keychain/         OS keychain abstraction
    salesforce/       OAuth + REST API client
    license/          Keygen.sh license validation
docs/
  setup/              Setup guides for users
```
