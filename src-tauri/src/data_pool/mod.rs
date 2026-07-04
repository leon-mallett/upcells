//! Data Pools — DuckDB-backed text-to-SQL over imported tabular data (§1).
//!
//! DuckDB is an in-process **analytical** engine used purely as a read-only query sandbox
//! over a rep's exported Salesforce data; SQLite (rusqlite) remains the app's source of
//! truth. One `.duckdb` file per pool. See `docs/UPCELLS_INFERENCE_NOTES.md` §1 and
//! `docs/sales-accelerator/PLAN.md`.
//!
//! **Phase 1 scaffolding.** The security-critical query sandbox ([`safety`]) lands first;
//! import/grid-cleaning, schema+samples, and the text-to-SQL query + 2-try repair loop
//! follow.
#![allow(dead_code)] // wired up incrementally through Phase 1

pub mod safety;

/// Maximum rows returned from a pool query (truncation is flagged to the UI). §1.5
pub const ROW_CAP: usize = 1000;
