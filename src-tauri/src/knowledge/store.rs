//! Vector store over `sqlite-vec` + chunk text (§6).

use rusqlite::{params, Connection, Result as SqlResult};
use serde::Serialize;

/// A retrieved chunk with its distance (smaller = more similar; L2 over unit-normalised vectors,
/// so ordering by distance equals ordering by cosine similarity).
#[derive(Debug, Clone, Serialize)]
pub struct Retrieved {
    pub chunk_id: String,
    pub source_id: String,
    pub text: String,
    pub distance: f32,
}

/// Pack a normalised embedding as little-endian f32 bytes for a `float[N]` vec0 column.
pub fn embedding_bytes(v: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for &x in v {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    bytes
}

/// Insert a chunk's text and its embedding. Caller wraps a batch in a transaction; the vector
/// row is kept in lock-step with the chunk row.
pub fn insert_chunk(
    conn: &Connection,
    chunk_id: &str,
    source_id: &str,
    ordinal: i64,
    text: &str,
    embedding: &[f32],
) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO knowledge_chunks (id, source_id, ordinal, text) VALUES (?1, ?2, ?3, ?4)",
        params![chunk_id, source_id, ordinal, text],
    )?;
    conn.execute(
        "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?1, ?2)",
        params![chunk_id, embedding_bytes(embedding)],
    )?;
    Ok(())
}

/// Delete a source's chunks and their vectors.
pub fn delete_source_chunks(conn: &Connection, source_id: &str) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM vec_chunks WHERE chunk_id IN \
         (SELECT id FROM knowledge_chunks WHERE source_id = ?1)",
        params![source_id],
    )?;
    conn.execute(
        "DELETE FROM knowledge_chunks WHERE source_id = ?1",
        params![source_id],
    )?;
    Ok(())
}

/// The `k` nearest chunks to a query embedding. The KNN runs in a CTE (sqlite-vec wants the
/// `MATCH` on the vec table alone), then joins to the chunk text.
pub fn search(conn: &Connection, query: &[f32], k: usize) -> SqlResult<Vec<Retrieved>> {
    let mut stmt = conn.prepare(
        "WITH nn AS ( \
           SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ?1 AND k = ?2 \
         ) \
         SELECT nn.chunk_id, nn.distance, c.source_id, c.text \
         FROM nn JOIN knowledge_chunks c ON c.id = nn.chunk_id \
         ORDER BY nn.distance",
    )?;
    let bytes = embedding_bytes(query);
    let rows = stmt.query_map(params![bytes, k as i64], |r| {
        Ok(Retrieved {
            chunk_id: r.get(0)?,
            distance: r.get::<_, f64>(1)? as f32,
            source_id: r.get(2)?,
            text: r.get(3)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::register_vec_extension;

    fn unit(idx: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; 768];
        v[idx] = 1.0;
        v
    }

    #[test]
    fn store_and_search_finds_nearest() {
        register_vec_extension();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, source_id TEXT, ordinal INTEGER, text TEXT);
             CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[768]);",
        )
        .unwrap();

        insert_chunk(&conn, "a", "s1", 0, "alpha", &unit(0)).unwrap();
        insert_chunk(&conn, "b", "s1", 1, "beta", &unit(1)).unwrap();
        insert_chunk(&conn, "c", "s1", 2, "gamma", &unit(2)).unwrap();

        // A query closest to chunk "a".
        let mut q = unit(0);
        q[1] = 0.3;
        let norm = q.iter().map(|x| x * x).sum::<f32>().sqrt();
        for x in q.iter_mut() {
            *x /= norm;
        }

        let hits = search(&conn, &q, 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].chunk_id, "a");
        assert_eq!(hits[0].text, "alpha");
        assert!(hits[0].distance <= hits[1].distance);
    }
}
