-- Sales Accelerator: knowledge base for semantic RAG (prospecting material).
-- Sources are ingested documents (files/URLs), split into chunks, each embedded.

CREATE TABLE IF NOT EXISTS knowledge_sources (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- 'file' | 'url'
    location    TEXT,                   -- file path or URL
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id        TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    ordinal   INTEGER NOT NULL,
    text      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks (source_id);

-- Vector store (sqlite-vec). One row per chunk; 768-dim nomic embeddings, L2-normalised.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    chunk_id  TEXT PRIMARY KEY,
    embedding float[768]
);
