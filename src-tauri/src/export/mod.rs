//! Export records to xlsx or csv.
//!
//! xlsx files get a Data sheet plus a Metadata sheet that records where the
//! data came from (connection, object, SOQL, timestamp, field types). The
//! metadata is load-bearing for the later Update feature: knowing each
//! column's Salesforce type is what lets us type-convert values on import.
//!
//! csv files get the same metadata as a sibling `.meta.json` file.

use crate::error::{AppError, AppResult};
use rust_xlsxwriter::{DataValidation, Format, Formula, Workbook};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportMetadata {
    pub connection_name: String,
    pub object_name: String,
    pub soql: String,
    pub exported_at: i64,
    pub record_count: usize,
    /// Column API name → Salesforce field type (e.g. "Name" → "string", "CloseDate" → "date")
    pub field_types: BTreeMap<String, String>,
}

// ── xlsx ──────────────────────────────────────────────────────────────────────

pub fn write_xlsx(
    path: &str,
    columns: &[String],
    records: &[serde_json::Value],
    metadata: &ExportMetadata,
    picklist_options: &BTreeMap<String, Vec<String>>,
) -> AppResult<()> {
    let mut workbook = Workbook::new();
    let last_data_row = records.len().max(1) as u32;

    // Track columns that need the hidden-sheet approach (total chars > 200)
    let mut long_picklists: Vec<(u16, String, Vec<String>)> = Vec::new();

    // ── Data sheet ───────────────────────────────────────────────────────────
    {
        let sheet = workbook.add_worksheet();
        sheet
            .set_name("Data")
            .map_err(|e| AppError::io(format!("Sheet name failed: {}", e)))?;

        let header_fmt = Format::new().set_bold();

        for (col, name) in columns.iter().enumerate() {
            sheet
                .write_with_format(0, col as u16, name, &header_fmt)
                .map_err(|e| AppError::io(format!("Header write failed: {}", e)))?;
        }

        for (row_idx, record) in records.iter().enumerate() {
            let row = (row_idx + 1) as u32;
            if let Some(obj) = record.as_object() {
                for (col_idx, col_name) in columns.iter().enumerate() {
                    if let Some(val) = obj.get(col_name) {
                        write_xlsx_cell(sheet, row, col_idx as u16, val)?;
                    }
                }
            }
        }

        // ── Picklist dropdown validation ─────────────────────────────────────
        // Short picklists (< 200 chars total) use inline validation. Long ones
        // are deferred to a hidden sheet + formula reference.
        for (col_idx, col_name) in columns.iter().enumerate() {
            if let Some(values) = picklist_options.get(col_name) {
                if values.is_empty() {
                    continue;
                }
                let total_chars: usize = values.iter().map(|v| v.len()).sum::<usize>() + values.len();
                let col = col_idx as u16;

                if total_chars < 200 {
                    let str_refs: Vec<&str> = values.iter().map(|s| s.as_str()).collect();
                    if let Ok(validation) = DataValidation::new().allow_list_strings(&str_refs) {
                        let _ = sheet.add_data_validation(1, col, last_data_row, col, &validation);
                    }
                } else {
                    long_picklists.push((col, col_name.clone(), values.clone()));
                }
            }
        }

        // Auto-fit columns for readability
        sheet.autofit();
    }

    // ── Metadata sheet ───────────────────────────────────────────────────────
    {
        let sheet = workbook.add_worksheet();
        sheet
            .set_name("Metadata")
            .map_err(|e| AppError::io(format!("Metadata sheet name failed: {}", e)))?;

        let label_fmt = Format::new().set_bold();

        let mut row: u32 = 0;
        let write_kv = |s: &mut rust_xlsxwriter::Worksheet,
                            r: &mut u32,
                            k: &str,
                            v: &str|
         -> AppResult<()> {
            s.write_with_format(*r, 0, k, &label_fmt)
                .map_err(|e| AppError::io(format!("Meta write failed: {}", e)))?;
            s.write(*r, 1, v)
                .map_err(|e| AppError::io(format!("Meta write failed: {}", e)))?;
            *r += 1;
            Ok(())
        };

        write_kv(sheet, &mut row, "Exported by", "Upcells")?;
        write_kv(sheet, &mut row, "Connection", &metadata.connection_name)?;
        write_kv(sheet, &mut row, "Object", &metadata.object_name)?;
        write_kv(sheet, &mut row, "Record count", &metadata.record_count.to_string())?;
        write_kv(
            sheet,
            &mut row,
            "Exported at (unix)",
            &metadata.exported_at.to_string(),
        )?;
        write_kv(sheet, &mut row, "SOQL", &metadata.soql)?;

        row += 1;
        sheet
            .write_with_format(row, 0, "Field", &label_fmt)
            .map_err(|e| AppError::io(format!("Meta write failed: {}", e)))?;
        sheet
            .write_with_format(row, 1, "Salesforce type", &label_fmt)
            .map_err(|e| AppError::io(format!("Meta write failed: {}", e)))?;
        row += 1;

        for col in columns {
            let ty = metadata
                .field_types
                .get(col)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string());
            sheet
                .write(row, 0, col.as_str())
                .map_err(|e| AppError::io(format!("Meta write failed: {}", e)))?;
            sheet
                .write(row, 1, ty.as_str())
                .map_err(|e| AppError::io(format!("Meta write failed: {}", e)))?;
            row += 1;
        }

        sheet.autofit();
    }

    // ── Hidden Picklists sheet (for long picklists exceeding inline limits) ──
    if !long_picklists.is_empty() {
        {
            let pl_sheet = workbook.add_worksheet();
            pl_sheet
                .set_name("Picklists")
                .map_err(|e| AppError::io(format!("Picklists sheet name failed: {}", e)))?;
            pl_sheet.set_hidden(true);

            for (offset, (_data_col, col_name, values)) in long_picklists.iter().enumerate() {
                let pl_col = offset as u16;
                let _ = pl_sheet.write(0, pl_col, col_name.as_str());
                for (row_idx, val) in values.iter().enumerate() {
                    let _ = pl_sheet.write((row_idx + 1) as u32, pl_col, val.as_str());
                }
            }
        }

        // Get the Data sheet back to apply formula-based validations
        if let Ok(data_sheet) = workbook.worksheet_from_name("Data") {
            for (offset, (data_col, _col_name, values)) in long_picklists.iter().enumerate() {
                let pl_col_letter = col_index_to_letter(offset as u16);
                let last_val_row = values.len() + 1; // +1 for the header row in the hidden sheet
                let formula_str = format!(
                    "=Picklists!${}$2:${}${}",
                    pl_col_letter, pl_col_letter, last_val_row
                );
                let validation = DataValidation::new()
                    .allow_list_formula(Formula::new(formula_str));
                let _ = data_sheet.add_data_validation(1, *data_col, last_data_row, *data_col, &validation);
            }
        }
    }

    workbook
        .save(path)
        .map_err(|e| AppError::io(format!("Failed to save xlsx: {}", e)))?;

    Ok(())
}

/// Convert a 0-based column index to an Excel column letter (A, B, ..., Z, AA, AB, ...).
fn col_index_to_letter(col: u16) -> String {
    let mut result = String::new();
    let mut n = col as u32;
    loop {
        result.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    result
}

fn write_xlsx_cell(
    sheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    val: &serde_json::Value,
) -> AppResult<()> {
    match val {
        serde_json::Value::Null => {
            // leave blank
            Ok(())
        }
        serde_json::Value::Bool(b) => sheet
            .write_boolean(row, col, *b)
            .map(|_| ())
            .map_err(|e| AppError::io(format!("xlsx write failed: {}", e))),
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                sheet
                    .write_number(row, col, f)
                    .map(|_| ())
                    .map_err(|e| AppError::io(format!("xlsx write failed: {}", e)))
            } else {
                Ok(())
            }
        }
        serde_json::Value::String(s) => sheet
            .write_string(row, col, s.as_str())
            .map(|_| ())
            .map_err(|e| AppError::io(format!("xlsx write failed: {}", e))),
        serde_json::Value::Object(obj) => {
            // Nested relationship — prefer Name, else serialise as JSON
            let display = obj
                .get("Name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| val.to_string());
            sheet
                .write_string(row, col, display.as_str())
                .map(|_| ())
                .map_err(|e| AppError::io(format!("xlsx write failed: {}", e)))
        }
        serde_json::Value::Array(_) => sheet
            .write_string(row, col, val.to_string().as_str())
            .map(|_| ())
            .map_err(|e| AppError::io(format!("xlsx write failed: {}", e))),
    }
}

// ── csv ───────────────────────────────────────────────────────────────────────

pub fn write_csv(
    path: &str,
    columns: &[String],
    records: &[serde_json::Value],
) -> AppResult<()> {
    let mut wtr = csv::Writer::from_path(path)
        .map_err(|e| AppError::io(format!("Failed to open csv: {}", e)))?;

    wtr.write_record(columns)
        .map_err(|e| AppError::io(format!("csv write failed: {}", e)))?;

    for record in records {
        if let Some(obj) = record.as_object() {
            let row: Vec<String> = columns
                .iter()
                .map(|col| obj.get(col).map(format_csv_value).unwrap_or_default())
                .collect();
            wtr.write_record(&row)
                .map_err(|e| AppError::io(format!("csv write failed: {}", e)))?;
        }
    }

    wtr.flush()
        .map_err(|e| AppError::io(format!("csv flush failed: {}", e)))?;

    Ok(())
}

pub fn write_metadata_json(csv_path: &str, metadata: &ExportMetadata) -> AppResult<()> {
    let meta_path = format!("{}.meta.json", csv_path);
    let json = serde_json::to_string_pretty(metadata)
        .map_err(|e| AppError::io(format!("Metadata serialise failed: {}", e)))?;
    std::fs::write(&meta_path, json)
        .map_err(|e| AppError::io(format!("Failed to write metadata: {}", e)))?;
    Ok(())
}

fn format_csv_value(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(obj) => obj
            .get("Name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| val.to_string()),
        serde_json::Value::Array(_) => val.to_string(),
    }
}
