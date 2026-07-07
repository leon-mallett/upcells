//! Ingestion pipeline (§6): extract → chunk → embed → store. Embedding is done first (no DB
//! lock held), then the source + chunks + vectors are written in one transaction.

use rusqlite::{params, Connection};

use crate::error::{AppError, AppResult};
use crate::inference::engine::InferenceEngine;
use crate::knowledge::{chunk::chunk_text, store};

/// Chunk `text` and embed each chunk. `on_step(done, total)` reports progress.
pub fn embed_chunks(
    engine: &InferenceEngine,
    text: &str,
    mut on_step: impl FnMut(usize, usize),
) -> AppResult<Vec<(String, Vec<f32>)>> {
    let chunks = chunk_text(text);
    if chunks.is_empty() {
        return Err(AppError::validation("no content to index"));
    }
    let total = chunks.len();
    let mut out = Vec::with_capacity(total);
    for (i, chunk) in chunks.into_iter().enumerate() {
        on_step(i + 1, total);
        let embedding = engine.embed(&chunk)?;
        out.push((chunk, embedding));
    }
    Ok(out)
}

/// Write a source and its embedded chunks in a single transaction. Returns the created-at ts.
pub fn store_source(
    conn: &Connection,
    source_id: &str,
    name: &str,
    kind: &str,
    location: Option<&str>,
    chunks: &[(String, Vec<f32>)],
) -> AppResult<i64> {
    let created_at = chrono::Utc::now().timestamp();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::db(format!("failed to begin transaction: {e}")))?;
    tx.execute(
        "INSERT INTO knowledge_sources (id, name, kind, location, chunk_count, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![source_id, name, kind, location, chunks.len() as i64, created_at],
    )
    .map_err(|e| AppError::db(format!("failed to save source: {e}")))?;

    for (i, (text, embedding)) in chunks.iter().enumerate() {
        let chunk_id = format!("{source_id}-{i}");
        store::insert_chunk(&tx, &chunk_id, source_id, i as i64, text, embedding)
            .map_err(|e| AppError::db(format!("failed to store chunk: {e}")))?;
    }
    tx.commit()
        .map_err(|e| AppError::db(format!("failed to commit: {e}")))?;
    Ok(created_at)
}

/// Embed a query and return the `k` most relevant chunks across all sources.
pub fn retrieve(
    conn: &Connection,
    engine: &InferenceEngine,
    query: &str,
    k: usize,
) -> AppResult<Vec<store::Retrieved>> {
    let embedding = engine.embed(query)?;
    store::search(conn, &embedding, k).map_err(|e| AppError::db(format!("retrieval failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::register_vec_extension;
    use std::path::Path;

    const SCHEMA: &str = "\
        CREATE TABLE knowledge_sources (id TEXT PRIMARY KEY, name TEXT, kind TEXT, location TEXT, chunk_count INTEGER, created_at INTEGER);\
        CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, source_id TEXT, ordinal INTEGER, text TEXT);\
        CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[768]);";

    /// Full RAG core end-to-end: ingest two sources, retrieve the relevant one.
    #[test]
    #[ignore = "requires an embedding GGUF via UPCELLS_SMOKE_EMBED_GGUF"]
    fn end_to_end_ingest_and_retrieve() {
        let path = std::env::var("UPCELLS_SMOKE_EMBED_GGUF").expect("set UPCELLS_SMOKE_EMBED_GGUF");
        let engine = InferenceEngine::new().unwrap();
        engine.load_embedding_model("nomic", Path::new(&path)).unwrap();

        register_vec_extension();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();

        let product = "Our SaaS product helps sales teams automate outreach and close deals faster with AI.";
        let policy = "Our refund policy allows returns within 30 days of purchase for a full refund.";
        let e1 = embed_chunks(&engine, product, |_, _| {}).unwrap();
        store_source(&conn, "s1", "Product", "file", None, &e1).unwrap();
        let e2 = embed_chunks(&engine, policy, |_, _| {}).unwrap();
        store_source(&conn, "s2", "Policy", "file", None, &e2).unwrap();

        let hits = retrieve(&conn, &engine, "How does the product help salespeople?", 1).unwrap();
        eprintln!("[retrieve] {:?}", hits.iter().map(|h| &h.source_id).collect::<Vec<_>>());
        assert_eq!(hits.len(), 1);
        // The product source is more relevant than the refund policy.
        assert_eq!(hits[0].source_id, "s1");
    }
}
