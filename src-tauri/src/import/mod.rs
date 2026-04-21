//! Read xlsx / csv files previously created by the Export feature.
//!
//! Both formats carry a sidecar `ExportMetadata` block that tells us which
//! connection + object the data came from, plus each column's Salesforce
//! field type. Those types are what make downstream value normalisation and
//! diffing reliable.

use crate::error::{AppError, AppResult};
use crate::export::ExportMetadata;
use calamine::{open_workbook_auto, Data, Reader};
use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How to interpret ambiguous slash-separated date strings like `06/07/2026`.
/// ISO means we still try the dateparsers but fall back conservatively; US
/// means prefer `MM/DD/YYYY`; International means prefer `DD/MM/YYYY`.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DateLocale {
    #[default]
    Iso,
    International,
    Us,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedFile {
    pub metadata: Option<ExportMetadata>,
    pub columns: Vec<String>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub row_count: usize,
    /// The format we detected from the file extension.
    pub format: String,
    pub file_path: String,
}

/// Reads an xlsx or csv by extension. `locale` controls how ambiguous
/// slash-separated dates are parsed.
pub fn read_file(path: &str, locale: DateLocale) -> AppResult<ParsedFile> {
    let lower = path.to_lowercase();
    if lower.ends_with(".xlsx") {
        read_xlsx(path, locale)
    } else if lower.ends_with(".csv") {
        read_csv(path, locale)
    } else {
        Err(AppError::validation(format!(
            "Unsupported file extension: {}",
            path
        )))
    }
}

// ── xlsx ──────────────────────────────────────────────────────────────────────

fn read_xlsx(path: &str, locale: DateLocale) -> AppResult<ParsedFile> {
    let mut workbook =
        open_workbook_auto(path).map_err(|e| AppError::io(format!("Failed to open xlsx: {}", e)))?;

    // ── Metadata first — we need field_types before parsing Data cells ──────
    let metadata = workbook
        .worksheet_range("Metadata")
        .ok()
        .and_then(|range| parse_metadata_sheet(&range));

    let field_types: BTreeMap<String, String> = metadata
        .as_ref()
        .map(|m| m.field_types.clone())
        .unwrap_or_default();

    // ── Data sheet ──────────────────────────────────────────────────────────
    let data_range = workbook
        .worksheet_range("Data")
        .or_else(|_| {
            // Fall back to first sheet if there's no "Data" tab
            workbook
                .sheet_names()
                .first()
                .cloned()
                .ok_or_else(|| calamine::Error::Msg("no sheets"))
                .and_then(|name| workbook.worksheet_range(&name))
        })
        .map_err(|e| AppError::io(format!("Failed to read Data sheet: {}", e)))?;

    let mut rows_iter = data_range.rows();

    let header_row = rows_iter
        .next()
        .ok_or_else(|| AppError::validation("File is empty"))?;
    let columns: Vec<String> = header_row
        .iter()
        .map(|c| data_to_string(c))
        .collect();

    let mut rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
    for row in rows_iter {
        let mut obj = serde_json::Map::new();
        for (col_idx, col_name) in columns.iter().enumerate() {
            if let Some(cell) = row.get(col_idx) {
                let ft = field_types.get(col_name).map(String::as_str);
                obj.insert(col_name.clone(), data_to_json_typed(cell, ft, locale));
            } else {
                obj.insert(col_name.clone(), serde_json::Value::Null);
            }
        }
        // Skip rows that are completely blank
        let all_null = obj.values().all(|v| v.is_null() || matches!(v, serde_json::Value::String(s) if s.is_empty()));
        if !all_null {
            rows.push(obj);
        }
    }

    Ok(ParsedFile {
        metadata,
        columns,
        row_count: rows.len(),
        rows,
        format: "xlsx".into(),
        file_path: path.to_string(),
    })
}

fn parse_metadata_sheet(range: &calamine::Range<Data>) -> Option<ExportMetadata> {
    use std::collections::BTreeMap;

    let mut connection_name = String::new();
    let mut object_name = String::new();
    let mut soql = String::new();
    let mut exported_at: i64 = 0;
    let mut record_count: usize = 0;
    let mut field_types: BTreeMap<String, String> = BTreeMap::new();

    // Metadata sheet layout (see export/mod.rs write_xlsx):
    //   Row 0: Exported by | Cells
    //   Row 1: Connection  | <name>
    //   Row 2: Object      | <name>
    //   Row 3: Record count| <n>
    //   Row 4: Exported at | <ts>
    //   Row 5: SOQL        | <text>
    //   Row 6: blank
    //   Row 7: Field | Salesforce type  (headers)
    //   Row 8..: <api name> | <type>
    let mut in_fields = false;
    for row in range.rows() {
        let key = row.first().map(data_to_string).unwrap_or_default();
        let val = row.get(1).map(data_to_string).unwrap_or_default();

        if in_fields {
            if !key.is_empty() && !val.is_empty() {
                field_types.insert(key, val);
            }
            continue;
        }

        match key.as_str() {
            "Connection" => connection_name = val,
            "Object" => object_name = val,
            "Record count" => record_count = val.parse().unwrap_or(0),
            "Exported at (unix)" => exported_at = val.parse().unwrap_or(0),
            "SOQL" => soql = val,
            "Field" if val == "Salesforce type" => in_fields = true,
            _ => {}
        }
    }

    Some(ExportMetadata {
        connection_name,
        object_name,
        soql,
        exported_at,
        record_count,
        field_types,
    })
}

fn data_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("<error: {:?}>", e),
    }
}

fn data_to_json(cell: &Data) -> serde_json::Value {
    match cell {
        Data::Empty => serde_json::Value::Null,
        Data::String(s) if s.is_empty() => serde_json::Value::Null,
        Data::String(s) => serde_json::Value::String(s.clone()),
        Data::Float(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Data::Int(i) => serde_json::Value::Number((*i).into()),
        Data::Bool(b) => serde_json::Value::Bool(*b),
        Data::DateTime(dt) => serde_json::Value::String(dt.to_string()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => serde_json::Value::String(s.clone()),
        Data::Error(e) => serde_json::Value::String(format!("<error: {:?}>", e)),
    }
}

/// Type-aware cell conversion. Uses the Salesforce `field_type` (from the
/// file's Metadata sheet or .meta.json sidecar) to correctly interpret
/// spreadsheet cells — most importantly dates.
///
/// Excel stores dates as serial numbers (days since 1899-12-30). When a user
/// edits a value in Excel, Excel will often auto-convert it to a date cell
/// behind the scenes, at which point calamine reads the cell as `Float` or
/// `DateTime` rather than a string. Without type awareness we'd see
/// "46233" where the user typed "2026-06-15".
fn data_to_json_typed(
    cell: &Data,
    field_type: Option<&str>,
    locale: DateLocale,
) -> serde_json::Value {
    match field_type {
        Some("date") => match cell {
            Data::Empty => serde_json::Value::Null,
            Data::Float(f) => excel_serial_to_date(*f)
                .map(|d| serde_json::Value::String(d.format("%Y-%m-%d").to_string()))
                .unwrap_or(serde_json::Value::Null),
            Data::Int(i) => excel_serial_to_date(*i as f64)
                .map(|d| serde_json::Value::String(d.format("%Y-%m-%d").to_string()))
                .unwrap_or(serde_json::Value::Null),
            Data::DateTime(dt) => excel_serial_to_date(dt.as_f64())
                .map(|d| serde_json::Value::String(d.format("%Y-%m-%d").to_string()))
                .unwrap_or(serde_json::Value::Null),
            Data::DateTimeIso(s) | Data::String(s) => {
                if s.is_empty() {
                    serde_json::Value::Null
                } else if let Some(d) = parse_date_string(s, locale) {
                    serde_json::Value::String(d.format("%Y-%m-%d").to_string())
                } else {
                    // Leave untouched — diff will flag the mismatch loudly
                    serde_json::Value::String(s.clone())
                }
            }
            _ => data_to_json(cell),
        },
        Some("datetime") => match cell {
            Data::Empty => serde_json::Value::Null,
            Data::Float(f) => excel_serial_to_datetime(*f)
                .map(|dt| serde_json::Value::String(format_datetime_iso(&dt)))
                .unwrap_or(serde_json::Value::Null),
            Data::Int(i) => excel_serial_to_datetime(*i as f64)
                .map(|dt| serde_json::Value::String(format_datetime_iso(&dt)))
                .unwrap_or(serde_json::Value::Null),
            Data::DateTime(dt) => excel_serial_to_datetime(dt.as_f64())
                .map(|d| serde_json::Value::String(format_datetime_iso(&d)))
                .unwrap_or(serde_json::Value::Null),
            Data::DateTimeIso(s) | Data::String(s) => {
                if s.is_empty() {
                    serde_json::Value::Null
                } else if let Some(dt) = parse_datetime_string(s, locale) {
                    serde_json::Value::String(format_datetime_iso(&dt))
                } else {
                    serde_json::Value::String(s.clone())
                }
            }
            _ => data_to_json(cell),
        },
        _ => data_to_json(cell),
    }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/// Convert an Excel serial date to a NaiveDate.
///
/// Excel's epoch is 1899-12-30 (accounting for Excel's historic 1900-leap-year
/// bug — serials from 60 onwards match `1899-12-30 + days`). Dates before
/// 1900-03-01 are slightly off but we don't worry about those.
fn excel_serial_to_date(serial: f64) -> Option<NaiveDate> {
    // Clamp to a sane range (~1900 to ~2200)
    if !(1.0..=150_000.0).contains(&serial) {
        return None;
    }
    let base = NaiveDate::from_ymd_opt(1899, 12, 30)?;
    base.checked_add_days(chrono::Days::new(serial as u64))
}

fn excel_serial_to_datetime(serial: f64) -> Option<NaiveDateTime> {
    if !(1.0..=150_000.0).contains(&serial) {
        return None;
    }
    let days = serial.floor() as u64;
    let fraction = serial - days as f64;
    let base = NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
    let day_added = base.checked_add_days(chrono::Days::new(days))?;
    let millis = (fraction * 86_400_000.0) as i64;
    day_added.checked_add_signed(chrono::Duration::milliseconds(millis))
}

/// Format a datetime in the UTC ISO 8601 form Salesforce uses on input.
fn format_datetime_iso(dt: &NaiveDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    )
}

/// Try a range of common date string formats.
///
fn parse_date_string(s: &str, locale: DateLocale) -> Option<NaiveDate> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }

    // If the string looks like an ISO datetime, just take the date part
    if trimmed.len() >= 10 {
        if let Ok(d) = NaiveDate::parse_from_str(&trimmed[..10], "%Y-%m-%d") {
            return Some(d);
        }
    }

    // Slash-separated heuristics — disambiguate when possible
    if let Some(d) = parse_slash_date(trimmed, locale) {
        return Some(d);
    }

    const FORMATS: &[&str] = &[
        "%Y-%m-%d",   // 2026-06-15
        "%Y/%m/%d",   // 2026/06/15
        "%d-%m-%Y",   // 15-06-2026
        "%d-%b-%Y",   // 15-Jun-2026
        "%d %b %Y",   // 15 Jun 2026
        "%d %B %Y",   // 15 June 2026
        "%b %d, %Y",  // Jun 15, 2026
        "%B %d, %Y",  // June 15, 2026
    ];
    for fmt in FORMATS {
        if let Ok(d) = NaiveDate::parse_from_str(trimmed, fmt) {
            return Some(d);
        }
    }
    None
}

/// Handle DD/MM/YYYY vs MM/DD/YYYY, using the user's preference when both
/// leading components are ≤ 12 (genuinely ambiguous). When one is > 12, we
/// can determine the format unambiguously regardless of preference.
fn parse_slash_date(s: &str, locale: DateLocale) -> Option<NaiveDate> {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    let first: u32 = parts[0].parse().ok()?;
    let second: u32 = parts[1].parse().ok()?;
    let third_str = parts[2];
    // Support 2-digit years by assuming 20XX
    let third: i32 = if third_str.len() == 2 {
        2000 + third_str.parse::<i32>().ok()?
    } else {
        third_str.parse().ok()?
    };

    // Case 1: first > 12 → must be day (DD/MM/YYYY)
    if first > 12 && first <= 31 && second >= 1 && second <= 12 {
        return NaiveDate::from_ymd_opt(third, second, first);
    }
    // Case 2: second > 12 → must be day (MM/DD/YYYY)
    if second > 12 && second <= 31 && first >= 1 && first <= 12 {
        return NaiveDate::from_ymd_opt(third, first, second);
    }
    // Case 3: both ≤ 12 — genuinely ambiguous, use the user's preference.
    if first >= 1 && first <= 12 && second >= 1 && second <= 12 {
        return match locale {
            DateLocale::Us => NaiveDate::from_ymd_opt(third, first, second),
            // ISO and International both prefer DD/MM for slash format
            _ => NaiveDate::from_ymd_opt(third, second, first),
        };
    }
    None
}

fn parse_datetime_string(s: &str, locale: DateLocale) -> Option<NaiveDateTime> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Salesforce datetime format variants
    const FORMATS: &[&str] = &[
        "%Y-%m-%dT%H:%M:%S%.3fZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%.3f%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ];
    for fmt in FORMATS {
        if let Ok(dt) = NaiveDateTime::parse_from_str(trimmed, fmt) {
            return Some(dt);
        }
    }

    // Fall back to parsing just the date part and defaulting the time
    parse_date_string(trimmed, locale).map(|d| d.and_hms_opt(0, 0, 0).unwrap_or_default())
}

// ── csv ───────────────────────────────────────────────────────────────────────

fn read_csv(path: &str, locale: DateLocale) -> AppResult<ParsedFile> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_path(path)
        .map_err(|e| AppError::io(format!("Failed to open csv: {}", e)))?;

    let columns: Vec<String> = rdr
        .headers()
        .map_err(|e| AppError::io(format!("Failed to read csv headers: {}", e)))?
        .iter()
        .map(|h| h.to_string())
        .collect();

    // ── Metadata sidecar first — we need field_types for csv string parsing ─
    let meta_path = format!("{}.meta.json", path);
    let metadata: Option<ExportMetadata> = std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str::<ExportMetadata>(&s).ok());

    let field_types: BTreeMap<String, String> = metadata
        .as_ref()
        .map(|m| m.field_types.clone())
        .unwrap_or_default();

    let mut rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
    for result in rdr.records() {
        let record = result.map_err(|e| AppError::io(format!("csv row failed: {}", e)))?;
        let mut obj = serde_json::Map::new();
        for (col_idx, col_name) in columns.iter().enumerate() {
            let val = record.get(col_idx).unwrap_or("");
            let ft = field_types.get(col_name).map(String::as_str);
            obj.insert(col_name.clone(), csv_string_to_json_typed(val, ft, locale));
        }
        rows.push(obj);
    }

    Ok(ParsedFile {
        metadata,
        columns,
        row_count: rows.len(),
        rows,
        format: "csv".into(),
        file_path: path.to_string(),
    })
}

/// Type-aware conversion for csv values (which always arrive as strings).
/// Handles locale-formatted dates that Excel produces on CSV save.
fn csv_string_to_json_typed(
    val: &str,
    field_type: Option<&str>,
    locale: DateLocale,
) -> serde_json::Value {
    if val.is_empty() {
        return serde_json::Value::Null;
    }

    match field_type {
        Some("date") => {
            if let Some(d) = parse_date_string(val, locale) {
                serde_json::Value::String(d.format("%Y-%m-%d").to_string())
            } else {
                serde_json::Value::String(val.to_string())
            }
        }
        Some("datetime") => {
            if let Some(dt) = parse_datetime_string(val, locale) {
                serde_json::Value::String(format_datetime_iso(&dt))
            } else {
                serde_json::Value::String(val.to_string())
            }
        }
        _ => serde_json::Value::String(val.to_string()),
    }
}
