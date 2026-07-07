//! Semantic RAG knowledge base (§6): ingest documents → chunk → embed → `sqlite-vec`, then
//! retrieve relevant passages to ground prospecting content.
//!
//! Phase 4 scaffolding: the vector store ([`store`]) lands first; chunking, extractors
//! (files + single-page web), ingestion, and retrieval-grounded generation follow.
#![allow(dead_code)] // wired up incrementally through Phase 4

pub mod chunk;
pub mod extract;
pub mod store;
