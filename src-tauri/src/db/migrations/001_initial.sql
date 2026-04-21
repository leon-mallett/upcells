CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'salesforce',
    instance_url TEXT,
    client_id TEXT,
    username TEXT,
    status TEXT NOT NULL DEFAULT 'untested',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_tested INTEGER
);

CREATE TABLE IF NOT EXISTS saved_queries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
    soql_text TEXT NOT NULL,
    object_name TEXT,
    last_run INTEGER,
    last_record_count INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS export_history (
    id TEXT PRIMARY KEY,
    query_id TEXT REFERENCES saved_queries(id) ON DELETE SET NULL,
    connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    format TEXT NOT NULL,
    record_count INTEGER,
    exported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_history (
    id TEXT PRIMARY KEY,
    connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
    query_id TEXT REFERENCES saved_queries(id) ON DELETE SET NULL,
    object_name TEXT NOT NULL,
    source_file_path TEXT,
    status TEXT NOT NULL,
    records_modified INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_deleted INTEGER DEFAULT 0,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error_summary TEXT
);

CREATE TABLE IF NOT EXISTS sync_record_results (
    id TEXT PRIMARY KEY,
    sync_id TEXT NOT NULL REFERENCES sync_history(id) ON DELETE CASCADE,
    salesforce_id TEXT,
    operation TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_connection ON saved_queries(connection_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_connection ON sync_history(connection_id);
CREATE INDEX IF NOT EXISTS idx_sync_record_results_sync ON sync_record_results(sync_id);
