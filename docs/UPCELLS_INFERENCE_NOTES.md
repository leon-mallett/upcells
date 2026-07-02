# Ragtag → Upcells: local-AI architecture notes

**Purpose.** Knowledge transfer from Ragtag's proven local-AI stack to Upcells, so
Upcells doesn't re-derive what already works. This is *architecture and rationale*,
not shared code — Upcells stays fully independent of Ragtag. Copy the patterns, own
your own copy.

**Who this is for.** The Claude session building Upcells (Tauri 2, Rust backend,
React frontend, already on rusqlite + WAL). Upcells exports Salesforce → Excel/CSV,
lets a rep edit locally, then re-imports to update records. The "local AI" it's
adding is — reading between the lines — mostly **analysis/chat over the exported
data** (natural-language questions → SQL over the sheet) plus possibly a
report-writer. That maps *extremely* cleanly onto two Ragtag subsystems: the
**Data Pools / text-to-SQL** engine (DuckDB) and the **inference stack**
(llama-cpp-2). Those are the two sections to read first (§1 and §3).

**Ragtag context for calibration.** Single-user, single-device, local-first,
offline-capable, no telemetry, no cloud inference. Hard licence rule: no GPL/AGPL,
and specifically **no native `onnxruntime` (`ort` crate)** — everything is either
pure-Rust or statically-vendored C with no runtime shared-lib dependency, so the
whole app ships as one binary. Those constraints repeatedly produced the *better*
design, not just a compliant one; worth keeping if Upcells wants the same
"one installer, works offline" story.

Everything below is drawn from the current Ragtag codebase (Tauri 2, Rust 2021).
Versions are exact and pinned — see the vetting table at the very end (§7).

---

## 1. Data Pools / text-to-SQL (highest priority for Upcells)

This is the part you'll want most: turn a spreadsheet into a queryable database and
answer natural-language questions by generating and running SQL. Ragtag calls these
**Data Pools** (Phase 33). **The query engine is DuckDB, not SQLite** — deliberately.

### 1.1 Why DuckDB (not SQLite) for the analytical side

- DuckDB is an in-process **analytical** (OLAP) engine: fast aggregations, `read_csv_auto`
  with real type inference, `TRY_CAST`, `regexp_replace`, window functions — the stuff
  ad-hoc "what's my pipeline by quarter" questions need.
- `duckdb` crate with the **`bundled`** feature compiles libduckdb statically → still
  one binary, no system dependency. Same principle as `rusqlite`'s `bundled`.
- You keep your existing SQLite (rusqlite + WAL) as the **app's** source of truth
  (metadata, pools, jobs, settings) and add DuckDB *alongside* purely as the query
  sandbox over imported tabular data. Two engines, two jobs. Ragtag does exactly this.

### 1.2 Storage & import

- **One DuckDB file per pool**: `app_data_dir/data_pools/{poolId}.duckdb` (+ its `.wal`).
  Isolated, deleted with the pool. For Upcells the natural unit is "one export session"
  or "one object type (Opportunities)".
- **CSV** → DuckDB's `read_csv_auto` with `sample_size=-1` (full scan for type inference).
- **XLSX** → parsed in Rust with **`calamine`** (first sheet, cells stringified), then
  inserted as typed tables. DuckDB's spreadsheet extensions are deliberately *not*
  enabled (keeps the query sandbox locked down; parse in Rust instead).
- **Grid-cleaning pipeline** before typing (this is what makes it survive real-world
  messy exports — Salesforce report exports are exactly this messy):
  1. drop fully-empty columns (spacers/trailing),
  2. skip sparse preamble rows — find first "dense" row (>50% non-empty) as the header
     (skips report titles/notes above the real header),
  3. name blank headers `column_1`, `column_2`, …,
  4. de-dupe colliding names with `_2`, `_3` suffixes,
  5. drop fully-empty data rows.
- **Currency/locale coercion pass** (best-effort, non-fatal): detect text columns that
  are really formatted numbers via regex `^\s*[£$€]?\s*-?[0-9][0-9,]*(\.[0-9]+)?\s*$`,
  and only coerce when **≥80%** of non-blank values match; transform with
  `TRY_CAST(regexp_replace(col,'[£$€,\s]','','g') AS DOUBLE)`, mapping `-`/`N/A`/`null`
  → NULL. Leaves genuine text (`"Q1 2025"`) alone. **Directly relevant to Upcells** —
  Salesforce currency/number exports carry symbols and thousands separators.
- **Schema captured** per column: name, DuckDB type (via `DESCRIBE`), null count, and
  **up to 5 distinct sample values**. The sample values are the single most useful thing
  for text-to-SQL quality (see next).

### 1.3 How the schema is shown to the model

Not full DDL. A compact plain-text listing **with sample values**, injected into a
focused system prompt:

```
- Table "opportunities" (412 rows):
    - "stage" VARCHAR (e.g. Prospecting, Closed Won, Closed Lost)
    - "amount" DOUBLE (e.g. 12500, 40000)
    - "close_date" DATE (e.g. 2026-03-31, 2026-06-30)
```

Key points:
- Column names are double-quoted exactly as stored, so the model copies them verbatim
  (survives spaces/weird names/`column_1`).
- **Sample values do the disambiguation work.** The prompt tells the model: *"To find
  the row for a label (like a quarter or a stage), filter on the column whose sample
  values match — even if the column has a generic name like column_1."* This is how
  "closed won" gets routed to `stage` without a semantic layer.
- **No semantic search over the schema** and no embeddings on columns. For a handful of
  tables with tens of columns it isn't needed. If Upcells hits Salesforce-wide schemas
  (hundreds of fields), that's the one place you'd add relevance selection — see §1.8.
- **Multi-table join hints** are computed deterministically (not by the model): compare
  every table pair, match columns by normalised name with compatible type (numeric vs
  text), surface "likely relationships" and a worked `JOIN … GROUP BY` example built
  from the *actual* schema. This scaffolds weak models into correct joins.
- A **worked example** filter+aggregate query is generated per-request from the real
  columns, teaching exact quoting (`SUM("amount")`, never `SUM "amount"`).

### 1.4 Generation parameters

- **Same chat model as normal chat** — no separate "SQL model" tier. The scaffolding
  (schema + sample values + rules + worked example + join hints + repair loop) is what
  makes even a small 3–4B model reliable, *not* a bigger model. Ragtag's default is a
  ~4B model and it works.
- `temperature = 0.0`, `top_p = 1.0`, `seed = 0` — fully deterministic. You want the
  same question to produce the same SQL.
- `max_tokens = 400`. SQL is short.
- The **persona/system-prompt is stripped** for the SQL step — a chatty persona fights
  "output only SQL" on small models. Persona comes back for the *answer* step (§1.6).

### 1.5 Execution safety (this is the part to copy carefully)

Defence in depth, two independent layers:

**Layer 1 — a hardened read-only DuckDB connection** (`open_for_query`):
```rust
Config::default()
  .access_mode(AccessMode::ReadOnly)?              // file opened read-only
  .enable_external_access(false)?                  // no filesystem / no network
  .enable_autoload_extension(false)?               // no extensions
  .with("autoinstall_known_extensions", "false")?  // no auto-install
  .with("lock_configuration", "true")?             // SQL can't SET its way back out
```
This alone blocks `COPY TO`, `read_csv()`, `httpfs`, `ATTACH`, extension loads, and
re-enabling any of the above via `SET`.

**Layer 2 — a statement allowlist** (`is_safe_select`), belt-and-braces:
1. strip `--` and `/* */` comments first (so forbidden verbs can't be smuggled),
2. must start with `SELECT` or `WITH`,
3. must be a **single** statement (reject anything after the first `;`),
4. reject if it contains any of: `insert update delete drop create alter attach copy
   pragma set install load call export read_csv read_parquet read_json read_text glob(
   system`.

**Row cap: 1000 rows** returned (truncation flagged to the UI). **No wall-clock query
timeout and no `memory_limit`** are set today — a genuine gap; on a huge sheet a
pathological query can spin. If Upcells imports large exports, add DuckDB's
`SET memory_limit` / a statement timeout, or run the query on a thread you can abandon.

### 1.6 The error-repair loop (self-correction)

Two attempts max:
```
for attempt in 1..=2:
    sql = generate_sql(schema, question, prev_error)   # prev_error empty on attempt 1
    if not is_safe_select(sql):  prev_error = "must be a single read-only SELECT…"; continue
    result = run(open_for_query(db), sql, ROW_CAP)
    if ok:   return (sql, result)
    else:    prev_error = enrich(duckdb_error)          # feed back, retry
return failure(prev_error)
```
The `enrich`/`retry_hint` step turns raw DuckDB errors into *actionable* guidance, e.g.
`Referenced column "region" not found` becomes *"The column 'region' is in table
'accounts', not the table you queried — JOIN 'accounts'…"*. That single enrichment
fixes most weak-model join/column mistakes on the second try. Two attempts is enough in
practice; more just burns latency.

### 1.7 Result handling → natural-language answer

- Query returns rows as **text** (every column `CAST … AS VARCHAR`) — consistent number/
  date formatting, NULL → absent.
- Then a **second model pass** narrates the result: the persona is given a preview of the
  result table (header + up to 30 rows, pipe-separated) and told *"Answer in plain
  English using ONLY the figures in the result above. Every value you state MUST appear
  in the result. Don't add analysis, don't show SQL."* If narration fails it degrades to
  "Here's what your data shows." rather than crashing.
- **Audit trail**: Ragtag keeps the generated SQL + the raw result on the message so the
  user can see *exactly* what was computed. For Upcells this matters double — a sales rep
  or manager should be able to verify "where did that number come from" before trusting
  it. Show the SQL and the table, not just the prose. (Ragtag's design principle here:
  when the model is weak, make failure *visible and auditable* rather than papering over
  it with a bigger model.)

### 1.8 What I'd do differently / watch for (text-to-SQL)

- **Hallucinated columns / wrong joins** are the top failure mode on small models. The
  three mitigations that actually moved the needle, in order: (1) **sample values in the
  schema**, (2) **deterministic join hints** computed in Rust, (3) the **error-repair
  loop with enriched hints**. Do all three; none alone is enough.
- **Ambiguity ("UK" → which field?) is not handled** in Ragtag today — no clarifying-
  question flow; the model guesses from sample values and if it's wrong you get a wrong
  answer, not a question. If Upcells' users ask fuzzy questions over Salesforce data,
  a "did you mean `Country = 'United Kingdom'` or `Region = 'UK & Ireland'`?" disambig
  step is a real, deliberate feature to add — Ragtag parked it as future work.
- **Add the query timeout + memory limit** Ragtag lacks.
- **Semantic schema selection** only becomes necessary at large schema width. If you
  export full Salesforce objects (200+ fields), embed the column descriptions once and
  retrieve the top-N relevant columns into the prompt; otherwise skip it.
- Keep temperature at 0 and keep the SQL step persona-free.

**Key files in Ragtag** (for the Upcells session to read if Leon shares them):
`src-tauri/src/data_pool.rs` (import, cleaning, coercion, safety, run_query),
`src-tauri/src/commands/chat.rs` (prompt build ~L1687–1820, repair loop ~L1618–1662,
retry hints ~L1874–1903, join inference ~L1940–1966, result narration ~L2032–2115),
`docs/PHASE_33_SPEC.md`.

---

## 2. Inference stack (the engine)

### 2.1 Engine & format

- **`llama-cpp-2` v0.1.150** (Rust binding that **vendors llama.cpp** — no separate
  runtime, no sidecar process, no localhost inference server). In-process, called from
  Rust. This is the single most important choice: it's mature, GGUF-native, and gives
  you Metal/CUDA/Vulkan/CPU for free from upstream llama.cpp.
- **Model format: GGUF**, quantized (Q4_K_M / Q5_K_M for chat; Q8_0 for the small
  embedding model). Downloaded from Hugging Face on first use.
- Version floor note: 0.1.150 is Ragtag's floor specifically because older vendored
  llama.cpp can't load 2026-era Qwen3.x GGUFs. Pin a **floor**, not an exact `=`, so you
  get llama.cpp bugfixes — but re-vet on bump (it pulls a big C++ blob).

### 2.2 Per-platform accelerators — one build, compile-time feature per target

Ragtag does **not** do runtime backend switching across a single universal binary. It
uses **per-target compile-time features** in Cargo.toml:
```toml
[target.'cfg(target_os = "macos")'.dependencies]
llama-cpp-2 = { version = "0.1.150", features = ["metal"] }

[target.'cfg(not(target_os = "macos"))'.dependencies]
llama-cpp-2 = { version = "0.1.150" }   # CPU today; CUDA/Vulkan are feature flags to add
```
- **macOS build → Metal compiled in.** **Windows/Linux build → CPU** today; CUDA and
  Vulkan are planned as additional build-time feature flags (the `GpuBackend` enum and
  detection scaffolding exist; the features aren't wired yet).
- Practical implication for Upcells' Windows story: you'll likely ship a **CPU build**
  first (works everywhere, no driver assumptions), and later add a **CUDA-featured build
  variant** if you want NVIDIA acceleration. That's separate installers per accelerator,
  not one universal binary that picks at runtime — llama.cpp's build model pushes you
  there. A CPU-only 3–4B Q4 model is perfectly usable for SQL/chat over a spreadsheet;
  don't over-invest in GPU early.
- **Runtime selection that *does* exist**: within a build, an enum picks CPU vs the
  compiled GPU backend, and the user can force CPU in settings. On GPU init failure,
  **llama.cpp itself falls back to CPU** — Ragtag doesn't catch/retry, it just works.
- **GPU layer offload** is a blunt binary today: CPU → `n_gpu_layers = 0`, GPU →
  `n_gpu_layers = 999` (llama.cpp caps to the model's real layer count = offload all).

### 2.3 Build integration & packaging gotchas

- `llama-cpp-2`'s build compiles vendored llama.cpp → you need a **C/C++ toolchain** in
  CI: Xcode command-line tools on macOS, MSVC build tools on Windows, gcc/clang on Linux.
  First clean build is slow (C++ + optionally CUDA). Ragtag sets
  `[profile.dev.package."*"] opt-level = 2` so the crypto/inference C code isn't
  unusably slow in dev while keeping your own crate unoptimised for fast iteration.
- **macOS universal DMG**: build per-arch and `lipo`, or ship separate Apple-Silicon /
  Intel installers. Metal only matters on Apple Silicon in practice.
- **Windows MSI**: the CPU build "just works"; a CUDA build requires the CUDA toolkit at
  build time and users with the right driver at runtime — hence a separate variant.
- Keep the single-binary discipline: prefer `bundled`/vendored C (statically linked)
  over runtime shared libraries. Ragtag's one hard exclusion is native onnxruntime
  (`ort`); it uses pure-Rust ML runtimes (Candle, rten) for everything llama.cpp doesn't
  cover. Upcells probably doesn't need those unless it adds voice.

### 2.4 Off-thread execution, streaming & cancellation

- The generation turn is spawned as a **`tokio::spawn` async task** (not `spawn_blocking`;
  the sampler loop is async-aware and yields). The Tauri command returns immediately with
  a handle; tokens arrive via events.
- **Streaming = Tauri events**, one event name per conversation:
  `chat:stream:{conversationId}` with payload `{ message_id, delta, done:false }`, and a
  terminal `chat:complete:{conversationId}` carrying the final persisted message + any
  citations/metadata. The per-conversation event name keeps multiple chats isolated.
  Frontend `listen()`s for the matching name and appends `delta`s.
  - Gotcha Ragtag hit: **Tauri 2 restricts characters in event names** — model ids with
    dots (`llama-3.2`) break event routing, so segments are sanitised (`.` → `_`) when
    building names like `model:download:{id}`. Sanitise any dynamic event-name segment.
- The sampler emits **per token**: inside the decode loop it calls `on_token(&chunk)`
  synchronously, which pushes a stream event; detokenisation is `token_to_piece_bytes`
  with `String::from_utf8_lossy` (holds partial multi-byte tokens gracefully).
- **Cancellation = a single `AtomicBool`** on the engine, checked every token iteration
  with `Ordering::Relaxed`. A "stop" command flips it; the loop breaks and returns the
  partial text. Cheap, lock-free, responsive even mid-decode. This is much simpler than
  channels/tokens and has been entirely sufficient for single-user.
- **Structured output during streaming** (relevant to your report-writer, §5): Ragtag has
  a "choices" mode where the model is asked for JSON and a small incremental extractor
  runs *inside* the `on_token` callback — it accumulates the raw stream but only emits
  clean deltas to the UI, so the user never sees raw JSON scaffolding leak mid-stream.
  Same hook point (`on_token`) is where you'd parse/guard a structured document format.

**Key files**: `src-tauri/src/inference/engine.rs` (load, context, sampler loop,
cancel flag), `src-tauri/src/inference/stream.rs` (event names + payloads),
`src-tauri/src/inference/gpu.rs` (backend detect/resolve), `src-tauri/src/commands/chat.rs`
(orchestration, spawn).

### 2.5 Model lifecycle

- Models are **lazy-loaded and kept warm** for the app session, held behind
  `tokio::sync::Mutex<Option<Loaded…>>` slots (chat, embedding, rerank each get one).
- **Model swap** is guarded: check the loaded `model_id` under the lock, only reload if
  different — no TOCTOU race.
- **Context sizing is hardware-aware and dynamic** (not a constant): `resolve_n_ctx`
  budgets `n_ctx` from *total* RAM minus the weights minus an OS reserve, divided by the
  model's KV-cache cost per token, clamped to a per-size-class ceiling, the model's
  trained length, and a 4096 floor. Using *total* (not *available*) RAM makes it stable
  across reboots. `n_batch = n_ctx` so a big augmented prompt decodes in one pass.
- **No LRU eviction yet** — models just stay resident until explicitly unloaded/swapped.
  On typical dev machines chat+embedding cohabit fine (~2.3 GB). Add LRU only if you hit
  memory pressure.

---

## 3. Model catalogue + hardware recommendation

### 3.1 Catalogue schema

A static, curated Rust array of `ModelEntry` (`inference/model_registry.rs`). Actual
fields (trimmed to the useful ones for Upcells):
```
id                     stable identifier, never renamed  (e.g. "qwen3.5-4b-q5_k_m")
display_name, description
kind                   Chat | Embedding | Rerank | Ocr
hugging_face_repo, hugging_face_file
approximate_size       download bytes (shown before download)
context_length         trained token length
licence                human-readable
size_class             Small | Mid | Large | Moe | XLarge
family                 groups quant variants of the same model
quant_label            "Q4_K_M" / "Q5_K_M" …
is_default_quant       exactly one per family
kv_bytes_per_token     KV-cache cost → drives context sizing
parameters             "3B" / "70B" (display)
min_ram_bytes          minimum to load at all
recommended_ram_bytes  comfort threshold
recommended_vram_bytes GPU-offload benefit threshold (0 = none)
disk_footprint_bytes
sha256                 Option — integrity pin (set for small custom-hosted models)
download_url           Option — override, else HF resolve/main
```
Curate a **small** list (a few chat sizes + one embedding model). Users pick; you
recommend. Stable `id`s are load-bearing — they're the key everywhere.

### 3.2 Hardware detection

- **RAM / CPU / disk**: `sysinfo` v0.32 (features `system`, `disk`) — total & available
  RAM, CPU brand/core count, free space on the models volume.
- **Apple Silicon**: unified memory → treat VRAM budget = total RAM.
- **NVIDIA VRAM**: `nvml-wrapper` v0.12 (loads the NVIDIA driver at runtime, fails
  silently on non-NVIDIA → `None`).
- **AMD / generic VRAM**: `ash` v0.38 (Vulkan) — enumerate physical devices, take the
  largest `DEVICE_LOCAL` heap. Also best-effort → `None` on failure.
- All GPU probes are **best-effort with graceful `None`**; recommendation still works off
  system RAM if VRAM is unknown (just lower confidence).

### 3.3 Recommendation logic

`memory_budget = unified RAM (Apple) | discrete VRAM (if known) | system RAM (fallback)`,
then a **3-tier** pick over the catalogue (one candidate per size class, current default
quant, disk must fit with a 2 GiB headroom):
1. **Comfortable** — `recommended_ram_bytes ≤ budget`: "Your computer can comfortably run X."
2. **Loadable** — `min_ram_bytes ≤ budget`: "X will work, though replies may feel slower."
3. **Fallback** — smallest model, honest caveat.
Confidence is `Low` only when a discrete GPU is present but VRAM couldn't be read.
**Disk check**: `disk_footprint + 2 GiB ≤ free`.

For Upcells: this whole subsystem is copyable near-verbatim. A sales laptop is the target
— lead with a small model recommendation and be honest about speed rather than
recommending something that OOMs.

---

## 4. Model downloader

`inference/model_downloader.rs`. Pattern:
- **URL resolution**: `hf-hub` v0.3 conceptually (Ragtag actually just formats the
  canonical `https://huggingface.co/{repo}/resolve/main/{file}` URL and does the transfer
  itself with **`reqwest` v0.12** (`rustls-tls`, `stream`) so it owns Range + progress).
- **Resumable**: writes to `{id}.{ext}.partial`, sends `Range: bytes={already}-` on
  resume, parses `Content-Range`/`Content-Length` for the true total, appends.
- **Progress**: throttled callback (every 256 KB or 250 ms) → Tauri event to the UI.
- **Cancellation**: `AtomicBool` checked per streamed chunk; leaves the `.partial` in
  place so a retry resumes.
- **Integrity**: streaming **SHA-256** (`sha2` v0.10, 1 MiB buffer — never loads the
  multi-GB file into memory) when a `sha256` is pinned; delete partial on mismatch.
- **Atomic publish**: `fs::rename(partial → final)` only after verify — so a half file is
  never seen as complete.
- **Storage**: `app_data_dir/models/{id}.{ext}`.

First-run UX (Ragtag §7.4 philosophy): frame the *first* download as a one-time setup
event with a friendly progress modal ("Setting up the AI on your computer (≈2 GB). This
may take a few minutes."), never a stack trace on failure — user-language errors with a
retry. After first run, load is instant.

---

## 5. Prompt / generation orchestration & structured documents

- **Per-task prompt assembly** happens Rust-side. The order Ragtag uses (adapt freely):
  persona/system prompt → user profile → any computed data-pool result (§1.7) →
  grounding/citation framing → the numbered CONTEXT block → the user question.
- **Grounded answers cite sources** with inline `[N]` markers that map 1-indexed to the
  retrieved passage order; Rust parses `[N]` back out of the stream and attaches
  `Citation` objects. There's a fallback: if the model wrote a substantive answer with no
  markers, attach the top hit — *unless* the answer is a refusal ("I couldn't find…"),
  detected by phrase-matching, in which case attach nothing. For Upcells' data answers,
  the equivalent "citation" is **the SQL + result table** (§1.7) — show your work.
- **Structured-document / report output**: reuse the streaming JSON-extractor pattern from
  §2.4 — ask the model for a structured format, run an incremental parser inside the
  `on_token` callback, emit only clean user-facing deltas, and validate/repair at the end.
  Keep temperature low for structured output. If a section must be exact (figures in a
  report), compute it with SQL and *inject* it rather than trusting the model to
  transcribe numbers — the same "compute, don't narrate from memory" rule as §1.7.

---

## 6. RAG (only if Upcells indexes unstructured material)

Likely secondary for Upcells (your data is tabular → §1 is the main event), but if you
index notes/attachments/docs:
- **Embedding**: `nomic-embed-text-v1.5` GGUF (Q8_0), **768 dims**, run through the same
  `llama-cpp-2` engine in embedding mode, **L2-normalised** (so cosine ≡ L2 on unit
  vectors). No `search_document:`/`search_query:` prefix is used. ~140 MB model.
- **Vector store**: **`sqlite-vec` v0.1** — ports cleanly onto your existing SQLite. A
  `vec0` virtual table `vec_chunks(chunk_id TEXT PRIMARY KEY, pool_id TEXT,
  embedding FLOAT[768])`; query with `WHERE pool_id = ? AND embedding MATCH ? ORDER BY
  distance LIMIT ?`; convert L2 distance → cosine as `1 - dist²/2`. Extension registered
  once at process start via `sqlite3_auto_extension` before migrations run. Chunk row and
  vector row inserted in the **same transaction** (invariant: every chunk has a vector).
- **Chunking**: 512-token window, 64 overlap, token count via **`tiktoken-rs` v0.5**
  `cl100k_base` (close enough to nomic's BPE for *sizing*), pulled back to a paragraph/
  sentence/word boundary in the back half of the window.
- **Extractors**: `pdf-extract` v0.7, `docx-rs` v0.4, `pulldown-cmark` v0.12, `scraper`
  v0.20, plus **`dom_smoothie` v0.17.0** for Readability-style HTML content extraction
  (with a text-density fallback).
- **Web import** (if ever needed): polite BFS with `reqwest` + `scraper` + **`robotstxt`
  v0.3** (the GPL `spider` crate is avoided). 500 ms crawl delay (100 ms floor),
  robots.txt honoured, 2000-page hard cap.
- **Retrieval defaults**: `top_k = 8`, `min_score = 0.55` cosine. **Reranker
  (`bge-reranker-v2-m3` cross-encoder) is OFF by default** — a hard-won lesson: cross-
  encoders score by literal answer-containment and *tank* category/aggregate queries
  ("Thai weeknight recipes" → 0.026 despite the right doc), so Ragtag uses it only to
  *reorder*, never to *filter*; the bi-encoder `min_score` is the only gate. Don't turn a
  reranker into a filter.

---

## 7. Exact versions for supply-chain vetting

All from `src-tauri/Cargo.toml` (Ragtag, Rust edition 2021, Tauri 2). Pinned as written;
where Ragtag pins a floor vs exact I've noted it. **Re-vet on any bump** — several of
these vendor large C/C++ blobs. Licences shown are Ragtag's allowlist findings
(MIT/Apache/BSD only; no GPL/AGPL; no native onnxruntime).

| Purpose | Crate | Version (as pinned) | Features / notes | Licence |
|---|---|---|---|---|
| LLM inference | `llama-cpp-2` | `0.1.150` (floor) | macOS: `["metal"]`; else base. Vendors llama.cpp | MIT |
| Analytical SQL | `duckdb` | `1.10504` | `["bundled"]` (static libduckdb) — **confirm latest** | MIT |
| XLSX parsing | `calamine` | `0.35` | reads workbook cells in Rust | MIT |
| App DB | `rusqlite` | `0.32` | `["bundled"]` | MIT |
| Migrations | `refinery` | `0.8` | `["rusqlite"]` | MIT |
| Vector store | `sqlite-vec` | `0.1` | `vec0` virtual table | Apache-2.0 |
| Token counting | `tiktoken-rs` | `0.5` | `cl100k_base` | MIT |
| HF URL resolution | `hf-hub` | `0.3` | `default-features=false, ["online","tokio"]` | Apache-2.0 |
| HTTP / download / crawl | `reqwest` | `0.12` | `default-features=false, ["rustls-tls","stream","json"]` | MIT/Apache-2.0 |
| Async streams | `futures-util` | `0.3` | | MIT/Apache-2.0 |
| Async IO utils | `tokio-util` | `0.7` | `["io"]` | MIT |
| Hashing | `sha2` | `0.10` | model integrity | MIT/Apache-2.0 |
| Async runtime | `tokio` | `1` | `["macros","rt-multi-thread","sync","fs"]` | MIT |
| Hardware probe | `sysinfo` | `0.32` | `default-features=false, ["system","disk"]` | MIT |
| NVIDIA VRAM | `nvml-wrapper` | `0.12` | runtime driver load, graceful None | MIT/Apache-2.0 |
| Vulkan VRAM | `ash` | `0.38` | best-effort device-local heap | MIT/Apache-2.0 |
| PDF text | `pdf-extract` | `0.7` | | MIT |
| DOCX text | `docx-rs` | `0.4` | read mode | MIT |
| Markdown | `pulldown-cmark` | `0.12` | `default-features=false` | MIT/Apache-2.0 |
| HTML DOM | `scraper` | `0.20` | | MIT |
| HTML readability | `dom_smoothie` | `0.17.0` | Readability port | MIT/Apache-2.0 |
| robots.txt | `robotstxt` | `0.3` | (avoid GPL `spider`) | Apache-2.0 |
| URL parse | `url` | `2` | | MIT/Apache-2.0 |
| Folder walk | `walkdir` / `globset` | `2` / `0.4` | | MIT/Apache-2.0 |
| IDs | `uuid` | `1` | `["v4","serde"]` | MIT/Apache-2.0 |
| Time | `chrono` | `0.4` | `["serde"]`, ISO-8601 strings everywhere | MIT/Apache-2.0 |
| Errors | `thiserror` | `1` | | MIT/Apache-2.0 |
| Logging | `tracing` / `tracing-subscriber` | `0.1` / `0.3` | | MIT |

**Not needed by Upcells unless it adds voice/OCR/vision** (listed only so you can ignore
them if you see them referenced): `candle-core/nn/transformers` 0.10 (Whisper STT, Kokoro
TTS), `rten`/`rten-tensor` 0.24 (OCR, VAD), `ocrs` 0.12.2, `cpal` 0.17.3, `tokenizers`
0.20, `piper-plus-g2p` 0.4.0, `misaki-rs` 0.3.0, `pdfium-render` 0.9, `libheif-rs` 2.7.
The **hard rule** across all of them: **no `ort` / native onnxruntime** — pure-Rust or
statically-vendored only, to preserve the one-binary/offline story.

---

## 8. TL;DR for the Upcells session

1. **Copy the Data Pools / DuckDB text-to-SQL design (§1) closely** — it's the piece that
   matches Upcells' core (analysis over exported Salesforce data). The wins are:
   sample-values-in-schema, deterministic join hints, hardened read-only connection +
   allowlist, and the 2-try error-repair loop. Add the query timeout Ragtag lacks, and
   consider the ambiguity/disambiguation step Ragtag deferred.
2. **Use `llama-cpp-2` + GGUF, in-process, one binary** (§2). Ship a CPU build first;
   Metal is a macOS compile feature, CUDA a later separate variant. Stream via
   per-conversation Tauri events; cancel via an `AtomicBool`.
3. **Reuse the catalogue + hardware-recommendation + resumable-verified-downloader
   patterns wholesale** (§3–4) — they're not product-specific.
4. **A small (3–4B Q4) model is enough** — quality comes from scaffolding and the
   repair loop, not model size. Make computed numbers auditable (show the SQL + table),
   never let the model transcribe figures from memory.
5. **RAG (§6) only if you index unstructured docs** — `sqlite-vec` drops onto your
   existing SQLite; keep the reranker as a reorderer, not a filter.

Questions or want a deeper dive on any subsystem? Leon can relay, or share the specific
Ragtag source file and I'll annotate it.
