-- Sales Accelerator: data pools (DuckDB-backed text-to-SQL sources).
-- Each row is metadata for one {id}.duckdb file under app_data_dir/pools.

CREATE TABLE IF NOT EXISTS data_pools (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    table_name   TEXT NOT NULL,
    source_file  TEXT,
    row_count    INTEGER NOT NULL DEFAULT 0,
    columns_json TEXT NOT NULL DEFAULT '[]',
    created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_pools_created_at ON data_pools (created_at DESC);
