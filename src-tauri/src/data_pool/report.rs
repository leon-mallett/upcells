//! Report writer (§2/§5).
//!
//! A report computes its figures with SQL (reusing the text-to-SQL engine) and then generates
//! a narrative grounded **strictly** in those figures — numbers are never transcribed from the
//! model's memory. A report is a set of metric questions (from a template, or LLM-derived from
//! a freeform request), each answered over the pool, then composed into a written report.

use std::path::Path;

use serde::Serialize;

use crate::data_pool::query::{answer_question, generate_clean};
use crate::data_pool::schema::{render_prompt_schema, PoolSchema};
use crate::error::{AppError, AppResult};
use crate::inference::engine::InferenceEngine;

const MAX_METRICS: usize = 6;
const PREVIEW_ROWS: usize = 15;

/// One computed metric: the question, the SQL that answered it, and the result rows.
#[derive(Debug, Clone, Serialize)]
pub struct MetricResult {
    pub question: String,
    pub sql: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// A generated report: the narrative plus the figures behind it (auditable).
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub title: String,
    pub narrative: String,
    pub metrics: Vec<MetricResult>,
}

/// Metric questions for a known template. Phrased generically so text-to-SQL adapts to whatever
/// columns the pool actually has; metrics that don't apply just get skipped.
pub fn template_metrics(template: &str) -> Option<(&'static str, Vec<&'static str>)> {
    let entry: (&str, &[&str]) = match template {
        "pipeline_summary" => (
            "Pipeline summary",
            &[
                "What is the total amount across all rows?",
                "What is the total amount grouped by stage?",
                "How many rows are there for each stage?",
                "What are the 5 largest opportunities by amount?",
            ],
        ),
        "activity_report" => (
            "Activity report",
            &[
                "How many rows are there in total?",
                "What is the count of rows grouped by owner?",
                "What is the total amount grouped by owner?",
                "What are the 5 most recent rows by date?",
            ],
        ),
        "win_loss" => (
            "Win/loss analysis",
            &[
                "How many rows are Closed Won versus Closed Lost?",
                "What is the total amount for Closed Won?",
                "What is the total amount for Closed Lost?",
                "What is the average amount for Closed Won?",
            ],
        ),
        _ => return None,
    };
    Some((entry.0, entry.1.to_vec()))
}

/// Derive metric questions from a freeform report request + the pool schema (the model lists
/// specific, SQL-answerable questions, one per line).
pub fn derive_metrics(
    engine: &InferenceEngine,
    schema: &PoolSchema,
    request: &str,
) -> AppResult<Vec<String>> {
    let schema_text = render_prompt_schema(schema);
    let prompt = format!(
        "You are planning a data report. Given the request and the schema, list up to {MAX_METRICS} \
         specific questions to compute from the data — one per line, no numbering, no explanation. \
         Each must be answerable by a single SQL query over the schema.\n\n\
         Schema:\n{schema_text}\n\nReport request: {request}\n\nQuestions:"
    );
    let raw = generate_clean(engine, &prompt, 0.2, 400)?;
    let metrics: Vec<String> = raw
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(|c: char| !c.is_alphabetic())
                .trim()
                .to_string()
        })
        .filter(|l| l.len() > 5)
        .take(MAX_METRICS)
        .collect();
    if metrics.is_empty() {
        return Err(AppError::inference("couldn't plan the report"));
    }
    Ok(metrics)
}

/// Compute each metric via text-to-SQL, then write a narrative grounded in the results. Metrics
/// that fail to produce a query are skipped. `on_step` reports progress (the current metric).
pub fn generate_report(
    engine: &InferenceEngine,
    pool_db: &Path,
    schema: &PoolSchema,
    title: &str,
    metrics: &[String],
    mut on_step: impl FnMut(&str),
) -> AppResult<Report> {
    let mut results = Vec::new();
    for question in metrics {
        on_step(question);
        if let Ok(r) = answer_question(engine, pool_db, schema, question, &[]) {
            results.push(MetricResult {
                question: question.clone(),
                sql: r.sql,
                columns: r.columns,
                rows: r.rows,
            });
        }
    }
    if results.is_empty() {
        return Err(AppError::inference(
            "couldn't compute any figures for this report — the data may not fit it",
        ));
    }

    on_step("Writing the report…");
    let narrative = compose_narrative(engine, title, &results)?;
    Ok(Report { title: title.to_string(), narrative, metrics: results })
}

fn compose_narrative(engine: &InferenceEngine, title: &str, metrics: &[MetricResult]) -> AppResult<String> {
    let mut figures = String::new();
    for m in metrics {
        figures.push_str(&format!("\n### {}\n{}\n", m.question, render_metric(m)));
    }
    let prompt = format!(
        "Write a concise, well-structured management report titled \"{title}\" for a sales manager, \
         using ONLY the figures below. Every number you state MUST appear in the figures — never \
         invent data. Use short sections with headings and bullet points. Do not show SQL and do \
         not add a preamble about being an AI.\n\nFigures:\n{figures}\n\nReport:"
    );
    let text = generate_clean(engine, &prompt, 0.4, 1024)?;
    if text.is_empty() {
        Ok("The report could not be generated.".to_string())
    } else {
        Ok(text)
    }
}

fn render_metric(m: &MetricResult) -> String {
    let mut out = m.columns.join(" | ");
    out.push('\n');
    for row in m.rows.iter().take(PREVIEW_ROWS) {
        out.push_str(&row.join(" | "));
        out.push('\n');
    }
    if m.rows.len() > PREVIEW_ROWS {
        out.push_str(&format!("… ({} more rows)\n", m.rows.len() - PREVIEW_ROWS));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_pool::import::import_csv;
    use crate::data_pool::schema::capture_schema;

    fn seed_pool() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("upcells-report-test");
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("opps.csv");
        std::fs::write(
            &csv,
            "Region,Opportunity,Amount\nUK,Acme,\"12500\"\nUK,Globex,\"40000\"\nUS,Initech,\"7000\"\n",
        )
        .unwrap();
        let pool = dir.join("report.duckdb");
        let _ = std::fs::remove_file(&pool);
        import_csv(&pool, "opportunities", &csv).unwrap();
        pool
    }

    #[test]
    fn template_metrics_are_defined() {
        assert!(template_metrics("pipeline_summary").is_some());
        assert!(template_metrics("win_loss").is_some());
        assert!(template_metrics("nope").is_none());
    }

    /// Freeform report end-to-end against the real model.
    #[test]
    #[ignore = "requires a local GGUF via UPCELLS_SMOKE_GGUF"]
    fn end_to_end_freeform_report() {
        let path = std::env::var("UPCELLS_SMOKE_GGUF").expect("set UPCELLS_SMOKE_GGUF");
        let pool = seed_pool();
        let schema = capture_schema(&pool).unwrap();
        let engine = InferenceEngine::new().expect("engine");
        engine
            .load_model("qwen3.5-4b-q5_k_m", std::path::Path::new(&path))
            .expect("load");

        let metrics = derive_metrics(&engine, &schema, "Summarise total amounts by region")
            .expect("derive");
        eprintln!("[metrics] {metrics:?}");
        let report = generate_report(&engine, &pool, &schema, "Regional summary", &metrics, |s| {
            eprintln!("[step] {s}");
        })
        .expect("report");
        eprintln!("[narrative]\n{}", report.narrative);
        assert!(!report.narrative.trim().is_empty());
        assert!(!report.metrics.is_empty());
    }
}
