# Sales Accelerator — Implementation Plan

Local-AI license tier for Upcells. 100% local (no cloud fallback), embedded inference,
mirroring the proven Ragtag architecture. Reference: [`docs/UPCELLS_INFERENCE_NOTES.md`](../UPCELLS_INFERENCE_NOTES.md)
(the Ragtag knowledge-transfer doc — section numbers below, e.g. §1, refer to it).

## Vision

A new "Sales Accelerator" tier giving salespeople a local AI assistant that:
1. **Data-pools / text-to-SQL** — natural-language questions over their Salesforce data
   ("top 3 largest opportunities in the UK"). *The v1 centerpiece.*
2. **Management reports** from closed-won / activity data.
3. **Coaching / motivation / strategy / ideation.**
4. **Prospecting content** via semantic RAG over the rep's brand/product/marketing material.

Three retrieval/generation modes, matched to data shape:
- **Data-pools / text-to-SQL** (DuckDB) — numerical/aggregate queries. Strongest fit; also powers reports.
- **Structured-context injection** — feed SQL-computed figures into report generation.
- **Semantic RAG** (sqlite-vec) — unstructured prose only. Deferred to last phase.

## Locked decisions (2026-07-02)

| # | Decision |
|---|---|
| Inference | `llama-cpp-2` (vendors llama.cpp, in-process, one binary), GGUF Q4/Q5 models |
| Default model | **Qwen 3.5 4B** (proven in Ragtag); catalogue offers larger models when hardware supports |
| Query engine | **DuckDB** (`bundled`/static) *alongside* rusqlite — read-only analytical sandbox; SQLite stays app source of truth |
| RAG store | `sqlite-vec` — **RAG/unstructured only** (Phase 4), NOT the query side |
| Data-pool source | **SOQL query results first** (typed, native); file-import (xlsx/csv) as fast-follow |
| Packaging | **CPU build first**; Metal = macOS compile feature; CUDA = later separate variant |
| Locality | 100% local, no cloud fallback |
| v1 MVP | Data-pools query panel (Phase 0 + 1); everything else deferred |
| Model quality | A small 3–4B Q4 is enough — quality comes from scaffolding, not model size |

## Architecture mapping onto Upcells

```
src-tauri/src/
├── inference/            NEW — mirrors Ragtag inference stack (§2)
│   ├── engine.rs         llama-cpp-2 load, context sizing, sampler loop, AtomicBool cancel
│   ├── stream.rs         per-conversation Tauri events (sanitise dotted ids → _)
│   ├── gpu.rs            backend detect/resolve (CPU now; Metal/CUDA features)
│   ├── model_registry.rs static ModelEntry catalogue (§3.1)
│   ├── hardware.rs       sysinfo + nvml-wrapper + ash detection (§3.2)
│   ├── recommend.rs      3-tier recommendation logic (§3.3)
│   └── model_downloader.rs resumable + SHA-256-verified HF download (§4)
├── data_pool/            NEW — mirrors Ragtag Data Pools (§1)
│   ├── mod.rs            pool lifecycle: one {poolId}.duckdb per pool
│   ├── import.rs         from SOQL results (typed) + xlsx/csv (grid-clean, currency coerce)
│   ├── schema.rs         compact schema + up-to-5 sample values; deterministic join hints
│   ├── safety.rs         open_for_query (read-only) + is_safe_select allowlist + row cap + timeout
│   └── query.rs          run_query, 2-try error-repair loop with enriched hints
├── commands/
│   ├── assistant.rs      NEW — chat/query orchestration, spawn, narration pass
│   └── license.rs        EXTEND — Sales Accelerator entitlement check
└── db/                   EXISTING SQLite — add pools/models/jobs metadata tables

src/
├── pages/AssistantPage.tsx   NEW route /assistant — "ask your pipeline" panel
└── components/assistant/     stream rendering, SQL+result audit view, model manager UI
```

## Phases

### Phase 0 — Inference foundation
- [x] `SECURITY.md` vetting pass (2026-07-02) — see Dependency status; deps to add: `llama-cpp-2` 0.1.150, `sysinfo` 0.32, `nvml-wrapper` 0.12, `ash` 0.38, `tokio-util` 0.7, `futures-util` 0.3 (`hf-hub` dropped)
- [x] `inference/engine.rs`: `llama-cpp-2` 0.1.150 — in-process GGUF load, sampler chain (greedy/temp), `AtomicBool` cancel, incremental UTF-8 token streaming via `on_token`. **Verified end-to-end** (loaded Qwen3.5 4B via Metal, generated correct output). `resolve_n_ctx` implemented (not yet wired to hardware). GPU offload folded into `engine.rs::default_gpu_layers` + `hardware.rs` (no separate `gpu.rs`).
- [x] `inference/stream.rs`: per-conversation Tauri event names + dotted-segment sanitisation (unit-tested)
- [x] **Step 2b-ii:** `InferenceEngine` in Tauri managed state (lazy backend init via `AiState`); async commands `load_ai_model`/`generate_ai`/`cancel_ai_generation` — `generate` runs on `spawn_blocking`, `on_token` bridged to `chat:stream:{id}` events + terminal `chat:complete:{id}`. (Wiring `resolve_n_ctx` to real hardware still TODO.)
- [x] Model catalogue (Qwen 3.5 4B default + 1.7B/8B/Q5 + nomic-embed) + 3-tier recommendation (unit-tested)
- [x] Hardware detection via `sysinfo` 0.32 (RAM/CPU/disk + Apple-unified GPU); verified on Apple M5 Max. NVIDIA (`nvml-wrapper`) + Vulkan (`ash`) VRAM deferred to step 2c (Windows/Linux)
- [x] Commands wired: `get_ai_hardware_info`, `list_ai_models`, `recommend_ai_model`
- [x] Resumable, SHA-256-verified downloader (`reqwest`, `Range` resume, atomic rename, cancel) + `download_ai_model`/`cancel_ai_download` commands streaming `model:download:{id}` progress. Real network path verified. **Catalogue now has real Ragtag coordinates** (Qwen3.5 4B default `bartowski/Qwen_Qwen3.5-4B-GGUF` Q5_K_M → 9B → 27B → 35B-A3B MoE, all Apache 2.0; nomic-embed for RAG; HF `resolve/main`, no sha pins). Friendly first-run modal is UI (later).
- [x] License tier gating: `LicenseInfo.sales_accelerator` parsed from Keygen `metadata.salesAccelerator`; `useSalesAccelerator()` hook (true in dev/skip mode) gates the sidebar nav link + shows an upsell on `/assistant` when not entitled. **Ops:** the purchase webhook must set `metadata.salesAccelerator=true` on tier licences. Matches the app's existing frontend-gated posture; backend command-level enforcement is a hardening follow-up.
- [ ] Proof point: load 4B model, stream tokens into a React panel

### Phase 1 — Data-pools / text-to-SQL (MVP centerpiece)
- [x] Add DuckDB `=1.10504.0` (`bundled`) alongside rusqlite — build validated on this Mac (1m51s). Pulls the Apache Arrow ecosystem (~20 crates) — flag for a `cargo-deny` pass. (Pool `{poolId}.duckdb` storage/lifecycle still to come.)
- [x] Execution safety (§1.5): hardened read-only connection (`open_for_query`) + statement allowlist (`is_safe_select`, tokenised so `offset`/`asset` don't false-trip) + `ROW_CAP=1000` + **`memory_limit`/`threads` caps** (fixes half Ragtag's gap; a wall-clock query timeout still TODO). 6 tests incl. real read-only-blocks-writes.
- [x] xlsx/csv import w/ grid-clean (drop empty cols, dense-header detection, `column_N` blanks, de-dupe, drop empty rows) + currency-coercion to DOUBLE (≥80%, hand-rolled matcher — no `regex` dep). `import_csv`/`import_xlsx` + `pool_path`. Verified end-to-end: messy CSV → cleaned → coerced → `SUM` via read-only connection. Also builds pools directly from CRM query results (`import_rows` + `create_data_pool_from_results`; "Save as Data Pool" on the query results) — the primary path.
- [x] Schema capture (`capture_schema`): DESCRIBE + up-to-5 sample values per column + deterministic join hints + per-request worked example; `render_prompt_schema` for the model. Verified against a real pool.
- [x] Text-to-SQL query + 2-try repair loop (`answer_question`): prompt assembly (schema+samples+rules+worked example), deterministic SQL gen, is_safe_select gate, run via read-only conn, enriched error feedback. **Qwen3.5 <think> reasoning blocks stripped** (extract_sql + narration) — key fix.
- [x] NL narration (`narrate`) grounded strictly in result figures; QueryResult carries SQL + text rows (auditable). Verified end-to-end vs real Qwen3.5 4B: "total amount for the UK?" → correct SQL → 52500 → "The total amount for the UK is 52500."
- [x] Command wiring + metadata: SQLite `data_pools` table (migration 002; `run_migrations` now applies incrementally) + commands `create_data_pool`/`list_data_pools`/`delete_data_pool`/`ask_data_pool` (question → SQL → run → narrate, on `spawn_blocking`). Builds clean; 28 tests pass.
- [x] `/assistant` route UI + IA restructure. Assistant is chat-centric: idea-shortcut chips (data ones prefill; "email"/"report" are `soon` placeholders), a pool picker, and answers with collapsible **auditable SQL + result table**. **Model manager moved to Settings → "AI Assistant" tab** (tier-gated); the Assistant reads an active-model query (`get_active_ai_model`) and prompts to set up model/data when missing. **Data pools management moved to Sales Data** (renamed from "Data"; now an Overview landing (quick actions, saved-query cards, data-pools summary) + Query CRM + Data Pools tabs). Saved-queries dropdown removed from the sidebar. Typed wrappers + `useAssistant` hooks. Typecheck + vite + rust build clean.

- [x] Conversational memory: the frontend owns the turn history and passes prior `{question, sql}` pairs (last 6) into the SQL prompt so follow-ups resolve ("And for the US?" → `WHERE "Region"='US'`). Verified vs real Qwen3.5 4B. History cleared on pool switch; a "New chat" resets it. (Narration stays grounded in the current result only.)

### Phase 2 — Report writer
- [ ] Streaming structured-document output (JSON-extractor in `on_token`, §2.4/§5)
- [ ] Compute figures via SQL and inject — never transcribe from memory
- [ ] Management-report templates over closed-won

### Phase 3 — Coaching / strategy
- [ ] Lightweight persona chat

### Phase 4 — Semantic RAG + prospecting + web import (only if indexing unstructured docs)
- [ ] `sqlite-vec` + `nomic-embed-text-v1.5` (768d, L2-normalised)
- [ ] Chunking (512/64, tiktoken sizing), extractors (pdf/docx/md/html via dom_smoothie)
- [ ] Polite crawler (reqwest + scraper + robotstxt); reranker as **reorderer only**, never a filter

## Open items / risks
- **Ambiguity handling** ("UK" → which field?) — Ragtag deferred it; a disambiguation step is a
  deliberate Upcells feature to consider given fuzzy questions over SF data.
- **Query timeout + memory_limit** — Ragtag lacks these; add for large SF exports.
- **Semantic schema selection** — only needed at large schema width (200+ SF fields); embed column
  descriptions + retrieve top-N then.
- **Binary size / build** — `llama-cpp-2` + `duckdb` both vendor large C/C++ blobs; C/C++ toolchain
  required in CI; first clean build is slow.
- **macOS universal DMG** — build per-arch + `lipo`, or separate Apple-Silicon/Intel installers.
- **Supply chain** — `llama-cpp-2` and `duckdb` warrant extra `SECURITY.md` scrutiny (large vendored C).

## Dependency status

Already in Upcells (vetted): `tokio`, `reqwest` 0.12, `rusqlite` 0.31, `uuid`, `chrono`,
`calamine` 0.26, `sha2` 0.10, `url`.

### Net-new vetting pass (2026-07-02 — none within 72h freshness window; all permissive licence)

| Crate | Pin | Published | Downloads | Verdict |
|---|---|---|---|---|
| `llama-cpp-2` | 0.1.150 (floor) | 2026-06-16 | 708k | ✅ vendors llama.cpp — re-vet on bump |
| `duckdb` | `bundled`, confirm version at add-time (Ragtag ~1.10504) | 2026-06-17 | 2.6M | ✅ vendors libduckdb — re-vet on bump |
| `sysinfo` | **0.32** (match Ragtag for code-port parity) | — | 162M | ✅ |
| `nvml-wrapper` | 0.12.1 | 2026-03-30 | 4.5M | ✅ |
| `ash` | 0.38 | 2024-04-01 | 27M | ✅ |
| `tokio-util` | 0.7 | 2026-01-04 | 634M | ✅ |
| `futures-util` | 0.3 | 2026-02-15 | 713M | ✅ |
| ~~`hf-hub`~~ | **dropped** | — | — | ➖ unneeded — format HF URL with `reqwest` (§4) |

**Resolved choices:** drop `hf-hub` (reqwest owns the download); pin `sysinfo` 0.32 for parity;
confirm `duckdb` `bundled` version when adding.

**Still owed before committing Phase 0:** `cargo audit` / `cargo-deny` for RUSTSEC advisories once
these are in `Cargo.lock` — not yet run. `llama-cpp-2` + `duckdb` compile large vendored C/C++, so
every version bump is a re-vet.
