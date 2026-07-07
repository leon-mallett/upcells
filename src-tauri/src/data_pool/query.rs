//! Text-to-SQL: prompt assembly, execution, and the 2-try repair loop (§1.4–1.7).
//!
//! The scaffolding here — sample-values-in-schema (from [`super::schema`]), a worked example,
//! exact-quoting rules, and an error-repair loop with enriched hints — is what makes even a
//! small 3–4B model reliable, rather than a bigger model. The SQL step is deterministic
//! (temperature 0) and persona-free; a separate pass narrates the result (§1.7).

use std::path::Path;

use duckdb::types::Value;
use serde::{Deserialize, Serialize};

use crate::data_pool::safety::{is_safe_select, open_for_query};
use crate::data_pool::schema::{join_hints, render_prompt_schema, worked_example, PoolSchema};
use crate::data_pool::ROW_CAP;
use crate::error::{AppError, AppResult};
use crate::inference::engine::{GenerationParams, InferenceEngine};

/// Max attempts (initial + one repair) at producing a working query. §1.6
const MAX_ATTEMPTS: usize = 2;
/// Rows of the result shown to the narration pass.
const NARRATION_PREVIEW_ROWS: usize = 30;
/// How many prior turns to feed into the SQL prompt as conversational context.
const HISTORY_LIMIT: usize = 6;

/// A prior conversation turn (question + the SQL that answered it), used so a follow-up like
/// "and for the US?" can be resolved against earlier questions.
#[derive(Debug, Clone, Deserialize)]
pub struct PriorTurn {
    pub question: String,
    pub sql: String,
}

/// Qwen3.x emits `<think>…</think>` reasoning. Prefilling a closed, empty block makes the
/// model spend **zero** tokens reasoning — critical on weak CPUs where thinking can exhaust
/// the generation budget before any answer appears (Ragtag's primary control; our
/// `strip_reasoning` stays as a belt-and-braces fallback). Detection: model id has "qwen3".
const THINK_PREFILL: &str = "\n<think>\n\n</think>\n\n";

fn with_think_prefill(engine: &InferenceEngine, prompt: String) -> String {
    match engine.loaded_model_id() {
        Some(id) if id.contains("qwen3") => format!("{prompt}{THINK_PREFILL}"),
        _ => prompt,
    }
}

/// The result of answering a question: the generated SQL plus the rows it produced (as text),
/// so the UI can show exactly what was computed (§1.7 — auditable).
#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub sql: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
    pub row_count: usize,
}

/// Answer a natural-language `question` against a pool: generate SQL, validate, run, and
/// repair once on failure. Returns the working query + result, or an error after both tries.
pub fn answer_question(
    engine: &InferenceEngine,
    pool_db: &Path,
    schema: &PoolSchema,
    question: &str,
    history: &[PriorTurn],
) -> AppResult<QueryResult> {
    let mut prev_error: Option<String> = None;
    for _ in 0..MAX_ATTEMPTS {
        let prompt = with_think_prefill(
            engine,
            build_sql_prompt(schema, question, prev_error.as_deref(), history),
        );
        let raw = engine.generate(&prompt, &GenerationParams::deterministic_sql(), |_| {})?;
        let sql = extract_sql(&raw);

        if let Err(e) = is_safe_select(&sql) {
            prev_error = Some(format!("{e}. Output only a single read-only SELECT query."));
            continue;
        }
        match run_sql(pool_db, &sql) {
            Ok(result) => return Ok(result),
            Err(e) => prev_error = Some(enrich_error(&e, schema)),
        }
    }
    Err(AppError::inference(format!(
        "could not produce a working query: {}",
        prev_error.unwrap_or_else(|| "unknown error".to_string())
    )))
}

/// Execute a validated read-only query, returning up to [`ROW_CAP`] rows as text.
pub fn run_sql(pool_db: &Path, sql: &str) -> AppResult<QueryResult> {
    is_safe_select(sql)?;
    let conn = open_for_query(pool_db)?;
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| AppError::db(format!("invalid query: {e}")))?;

    let mut rows_out: Vec<Vec<String>> = Vec::new();
    let mut truncated = false;
    let mut rows = stmt
        .query([])
        .map_err(|e| AppError::db(format!("query failed: {e}")))?;
    // Column names are available from the statement once it has been executed.
    let columns: Vec<String> = rows.as_ref().map(|s| s.column_names()).unwrap_or_default();
    let ncols = columns.len();
    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::db(format!("query failed: {e}")))?
    {
        if rows_out.len() >= ROW_CAP {
            truncated = true;
            break;
        }
        let mut cells = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let value: Value = row
                .get(i)
                .map_err(|e| AppError::db(format!("failed to read cell: {e}")))?;
            cells.push(format_value(value));
        }
        rows_out.push(cells);
    }

    Ok(QueryResult {
        sql: sql.to_string(),
        columns,
        row_count: rows_out.len(),
        truncated,
        rows: rows_out,
    })
}

/// Narrate a result in plain English, grounded strictly in the returned figures (§1.7).
pub fn narrate(engine: &InferenceEngine, question: &str, result: &QueryResult) -> AppResult<String> {
    let preview = render_result_preview(result);
    let prompt = format!(
        "A question was asked and answered by querying the user's sales data.\n\n\
         Question: {question}\n\n\
         Result table:\n{preview}\n\n\
         Answer in plain English using ONLY the figures in the result above. Every value you \
         state MUST appear in the result. Do not add analysis and do not show SQL.\n\nAnswer:"
    );
    let text = generate_clean(engine, &prompt, 0.3, 512)?;
    if text.is_empty() {
        Ok("Here's what your data shows.".to_string())
    } else {
        Ok(text)
    }
}

/// Run a generation with the qwen think-prefill applied and `<think>` reasoning stripped —
/// shared by narration and the report writer.
pub(crate) fn generate_clean(
    engine: &InferenceEngine,
    prompt: &str,
    temperature: f32,
    max_tokens: u32,
) -> AppResult<String> {
    let params = GenerationParams { temperature, max_tokens, ..Default::default() };
    let raw = engine.generate(&with_think_prefill(engine, prompt.to_string()), &params, |_| {})?;
    Ok(strip_reasoning(&raw))
}

/// Remove `<think>…</think>` reasoning blocks that hybrid models (Qwen3.5) emit. Models put
/// reasoning first and the answer after the closing tag, so keep what follows the last one.
fn strip_reasoning(raw: &str) -> String {
    if let Some(end) = raw.rfind("</think>") {
        return raw[end + "</think>".len()..].trim().to_string();
    }
    // An unclosed <think> means the answer never arrived — drop the reasoning.
    if let Some(start) = raw.find("<think>") {
        return raw[..start].trim().to_string();
    }
    raw.trim().to_string()
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

fn build_sql_prompt(
    schema: &PoolSchema,
    question: &str,
    prev_error: Option<&str>,
    history: &[PriorTurn],
) -> String {
    let mut prompt = String::new();
    prompt.push_str(
        "You are a DuckDB SQL generator. Output ONLY a single read-only SQL SELECT query — no \
         explanation, no markdown fences.\n\n\
         Rules:\n\
         - Use the exact column names shown, double-quoted (e.g. \"Amount\"). Never invent columns.\n\
         - To find rows for a label (a stage, region, quarter…), filter on the column whose sample \
         values match it — even if the column has a generic name.\n\
         - Use SUM/AVG/COUNT with GROUP BY for totals; ORDER BY … DESC + LIMIT for \"top N\".\n\
         - A follow-up question may refer to an earlier one (e.g. \"and for the US?\"); reuse the \
         earlier query's shape, changing only what the follow-up asks.\n\
         - Only SELECT is allowed.\n\n",
    );

    prompt.push_str("Schema:\n");
    prompt.push_str(&render_prompt_schema(schema));

    let hints = join_hints(schema);
    if !hints.is_empty() {
        prompt.push_str("\nLikely relationships:\n");
        for h in hints {
            prompt.push_str(&format!("- {h}\n"));
        }
    }

    if let Some(example) = worked_example(schema) {
        prompt.push_str(&format!("\nExample of correct quoting:\n{example}\n"));
    }

    // Conversational context: the most recent prior turns (question + the SQL that answered it).
    if !history.is_empty() {
        prompt.push_str("\nEarlier in this conversation:\n");
        let start = history.len().saturating_sub(HISTORY_LIMIT);
        for turn in &history[start..] {
            prompt.push_str(&format!("- Q: {}\n  SQL: {}\n", turn.question, turn.sql));
        }
    }

    prompt.push_str(&format!("\nQuestion: {question}\n"));

    if let Some(err) = prev_error {
        prompt.push_str(&format!(
            "\nYour previous attempt failed: {err}\nFix it and output only the corrected SQL.\n"
        ));
    }

    prompt.push_str("\nSQL:");
    prompt
}

/// Pull a single SQL statement out of a model response (strip markdown fences and prose).
fn extract_sql(raw: &str) -> String {
    let cleaned = strip_reasoning(raw);
    let mut s = cleaned.trim();
    if let Some(rest) = s.strip_prefix("```") {
        let rest = rest.trim_start_matches("sql").trim_start();
        s = rest.split("```").next().unwrap_or(rest);
    }
    // Take from the first SELECT/WITH keyword.
    let lower = s.to_lowercase();
    let start = [lower.find("select"), lower.find("with")]
        .into_iter()
        .flatten()
        .min();
    if let Some(i) = start {
        if let Some(sub) = s.get(i..) {
            s = sub;
        }
    }
    // Keep a single statement.
    s.split(';').next().unwrap_or(s).trim().to_string()
}

/// Turn a raw execution error into actionable guidance for the repair attempt (§1.6).
fn enrich_error(err: &AppError, schema: &PoolSchema) -> String {
    let msg = &err.message;
    let hint = missing_column(msg)
        .and_then(|col| {
            table_with_column(schema, &col)
                .map(|t| format!(" The column \"{col}\" is in table \"{t}\" — reference it there."))
        })
        .unwrap_or_default();
    format!("{msg}.{hint} Use only the exact quoted column names from the schema.")
}

/// Extract a column name from a "not found / does not exist" error, if present.
fn missing_column(msg: &str) -> Option<String> {
    let lower = msg.to_lowercase();
    if !(lower.contains("not found") || lower.contains("does not exist") || lower.contains("referenced column")) {
        return None;
    }
    // The name is usually the first double-quoted token.
    let start = msg.find('"')? + 1;
    let end = msg[start..].find('"')? + start;
    Some(msg[start..end].to_string())
}

fn table_with_column(schema: &PoolSchema, column: &str) -> Option<String> {
    let target = column.to_lowercase();
    schema.tables.iter().find_map(|t| {
        t.columns
            .iter()
            .any(|c| c.name.to_lowercase() == target)
            .then(|| t.name.clone())
    })
}

fn render_result_preview(result: &QueryResult) -> String {
    let mut out = result.columns.join(" | ");
    out.push('\n');
    for row in result.rows.iter().take(NARRATION_PREVIEW_ROWS) {
        out.push_str(&row.join(" | "));
        out.push('\n');
    }
    if result.rows.len() > NARRATION_PREVIEW_ROWS {
        out.push_str(&format!("… ({} more rows)\n", result.rows.len() - NARRATION_PREVIEW_ROWS));
    }
    out
}

fn format_value(value: Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Boolean(b) => b.to_string(),
        Value::TinyInt(n) => n.to_string(),
        Value::SmallInt(n) => n.to_string(),
        Value::Int(n) => n.to_string(),
        Value::BigInt(n) => n.to_string(),
        Value::HugeInt(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(f) => f.to_string(),
        Value::Decimal(d) => d.to_string(),
        Value::Text(s) => s,
        other => format!("{other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_pool::import::import_csv;
    use crate::data_pool::schema::capture_schema;

    fn seed_pool() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("upcells-query-test");
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("opps.csv");
        std::fs::write(
            &csv,
            "Region,Opportunity,Amount\nUK,Acme,\"£12,500\"\nUK,Globex,\"£40,000\"\nUS,Initech,\"$7,000\"\n",
        )
        .unwrap();
        let pool = dir.join("query.duckdb");
        let _ = std::fs::remove_file(&pool);
        import_csv(&pool, "opportunities", &csv).unwrap();
        pool
    }

    #[test]
    fn extracts_sql_from_fenced_and_prose_responses() {
        assert_eq!(extract_sql("```sql\nSELECT 1\n```"), "SELECT 1");
        assert_eq!(
            extract_sql("Sure! SELECT * FROM t WHERE x = 1; -- done"),
            "SELECT * FROM t WHERE x = 1"
        );
        assert_eq!(extract_sql("WITH a AS (SELECT 1) SELECT * FROM a"), "WITH a AS (SELECT 1) SELECT * FROM a");
    }

    #[test]
    fn strips_reasoning_blocks() {
        assert_eq!(strip_reasoning("<think>hmm</think>SELECT 1"), "SELECT 1");
        assert_eq!(strip_reasoning("<think>unclosed"), "");
        assert_eq!(strip_reasoning("no reasoning"), "no reasoning");
        // A "select" mentioned inside reasoning must not be mistaken for the query.
        assert_eq!(
            extract_sql("<think>I'll select the region</think>```sql\nSELECT \"Region\" FROM t\n```"),
            "SELECT \"Region\" FROM t"
        );
    }

    #[test]
    fn runs_a_query_and_returns_text_rows() {
        let pool = seed_pool();
        let result = run_sql(
            &pool,
            "SELECT \"Region\", SUM(\"Amount\") AS total FROM opportunities GROUP BY \"Region\" ORDER BY total DESC",
        )
        .expect("query");
        assert_eq!(result.columns, vec!["Region", "total"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0][0], "UK");
        assert_eq!(result.rows[0][1], "52500");
        assert!(!result.truncated);
    }

    #[test]
    fn run_sql_rejects_unsafe() {
        let pool = seed_pool();
        assert!(run_sql(&pool, "DROP TABLE opportunities").is_err());
    }

    #[test]
    fn prompt_includes_schema_samples_and_question() {
        let pool = seed_pool();
        let schema = capture_schema(&pool).unwrap();
        let prompt = build_sql_prompt(&schema, "total amount by region", None, &[]);
        assert!(prompt.contains("\"Region\""));
        assert!(prompt.contains("e.g."));
        assert!(prompt.contains("total amount by region"));
        assert!(prompt.contains("SQL:"));
    }

    /// Full text-to-SQL against the real model + a real pool.
    /// `UPCELLS_SMOKE_GGUF=/path/model.gguf cargo test --lib data_pool::query -- --ignored --nocapture`
    #[test]
    #[ignore = "requires a local GGUF via UPCELLS_SMOKE_GGUF"]
    fn end_to_end_text_to_sql() {
        let path = std::env::var("UPCELLS_SMOKE_GGUF").expect("set UPCELLS_SMOKE_GGUF");
        let pool = seed_pool();
        let schema = capture_schema(&pool).unwrap();
        let engine = InferenceEngine::new().expect("engine");
        // Load with a qwen3 id so the think-prefill path is exercised.
        engine
            .load_model("qwen3.5-4b-q5_k_m", std::path::Path::new(&path))
            .expect("load");

        let result =
            answer_question(&engine, &pool, &schema, "What is the total amount for the UK?", &[])
                .expect("answer");
        eprintln!("[sql] {}", result.sql);
        eprintln!("[rows] {:?}", result.rows);
        let narration = narrate(&engine, "What is the total amount for the UK?", &result).expect("narrate");
        eprintln!("[answer] {narration}");
        // The correct total is 52500; the narration should mention it.
        assert!(narration.contains("52") || result.rows.iter().flatten().any(|c| c.contains("52500")));
    }

    /// Conversational memory: a follow-up ("And for the US?") resolves against the prior turn.
    #[test]
    #[ignore = "requires a local GGUF via UPCELLS_SMOKE_GGUF"]
    fn end_to_end_follow_up_uses_history() {
        let path = std::env::var("UPCELLS_SMOKE_GGUF").expect("set UPCELLS_SMOKE_GGUF");
        let pool = seed_pool();
        let schema = capture_schema(&pool).unwrap();
        let engine = InferenceEngine::new().expect("engine");
        engine
            .load_model("qwen3.5-4b-q5_k_m", std::path::Path::new(&path))
            .expect("load");

        let q1 = "What is the total amount for the UK?";
        let first = answer_question(&engine, &pool, &schema, q1, &[]).expect("first");
        let history = vec![PriorTurn { question: q1.to_string(), sql: first.sql.clone() }];

        let follow = answer_question(&engine, &pool, &schema, "And for the US?", &history)
            .expect("follow-up");
        eprintln!("[follow-up sql] {}", follow.sql);
        eprintln!("[follow-up rows] {:?}", follow.rows);
        // The US total is 7000; the follow-up should resolve "US" from context, not error.
        assert!(follow.rows.iter().flatten().any(|c| c.contains("7000")));
    }
}
