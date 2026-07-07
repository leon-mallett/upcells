//! Text extraction from source documents (§6). Files now (PDF/DOCX/TXT/MD); single-page web
//! extraction is added alongside ingestion.

use std::path::Path;

use crate::error::{AppError, AppResult};

/// Extract plain text from a supported file by extension.
pub fn extract_file(path: &Path) -> AppResult<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let text = match ext.as_str() {
        "txt" | "text" | "md" | "markdown" => std::fs::read_to_string(path)
            .map_err(|e| AppError::io(format!("failed to read file: {e}")))?,
        "pdf" => pdf_extract::extract_text(path)
            .map_err(|e| AppError::io(format!("failed to read PDF: {e:?}")))?,
        "docx" => extract_docx(path)?,
        _ => {
            return Err(AppError::validation(
                "unsupported file — use PDF, DOCX, TXT or Markdown",
            ))
        }
    };
    if text.trim().is_empty() {
        return Err(AppError::validation("no readable text found in the file"));
    }
    Ok(text)
}

fn extract_docx(path: &Path) -> AppResult<String> {
    use docx_rs::{read_docx, DocumentChild};
    let bytes =
        std::fs::read(path).map_err(|e| AppError::io(format!("failed to read docx: {e}")))?;
    let docx = read_docx(&bytes).map_err(|e| AppError::io(format!("failed to parse docx: {e:?}")))?;
    let mut out = String::new();
    for child in &docx.document.children {
        if let DocumentChild::Paragraph(p) = child {
            let line = p.raw_text();
            if !line.trim().is_empty() {
                out.push_str(line.trim());
                out.push('\n');
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_text_and_markdown() {
        let dir = std::env::temp_dir().join("upcells-extract-test");
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("brand.md");
        std::fs::write(&md, "# Our product\n\nWe help sales teams close faster.").unwrap();
        let text = extract_file(&md).unwrap();
        assert!(text.contains("close faster"));
    }

    #[test]
    fn rejects_unsupported() {
        let dir = std::env::temp_dir().join("upcells-extract-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.bin");
        std::fs::write(&f, [0u8, 1, 2]).unwrap();
        assert!(extract_file(&f).is_err());
    }
}
