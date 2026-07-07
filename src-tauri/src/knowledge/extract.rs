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

const USER_AGENT: &str = "UpcellsBot";

/// Fetch a single web page and extract its main readable text (readability). Honours robots.txt.
/// Returns `(name, text)`.
pub async fn extract_url(url: &str) -> AppResult<(String, String)> {
    let client = reqwest::Client::builder()
        .user_agent(format!("{USER_AGENT}/0.1 (+https://upcells.app)"))
        .build()
        .map_err(|e| AppError::api(format!("http client error: {e}")))?;

    if !robots_allows(&client, url).await {
        return Err(AppError::validation(
            "that site's robots.txt disallows fetching this page",
        ));
    }

    let html = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::api(format!("failed to fetch page: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::api(format!("page returned an error: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::api(format!("failed to read page: {e}")))?;

    let article = dom_smoothie::Readability::new(html.as_str(), Some(url), None)
        .and_then(|mut r| r.parse())
        .map_err(|e| AppError::api(format!("couldn't extract content: {e:?}")))?;

    let text = article.text_content.to_string();
    if text.trim().is_empty() {
        return Err(AppError::validation("no readable content found on that page"));
    }
    let name = if !article.title.trim().is_empty() {
        article.title.clone()
    } else {
        article.site_name.clone().unwrap_or_else(|| url.to_string())
    };
    Ok((name, text))
}

/// Whether robots.txt allows our agent to fetch `url`. Missing/unreadable robots.txt → allowed.
async fn robots_allows(client: &reqwest::Client, url: &str) -> bool {
    let Some(robots_url) = robots_url_for(url) else {
        return true;
    };
    let body = match client.get(&robots_url).send().await {
        Ok(resp) if resp.status().is_success() => resp.text().await.unwrap_or_default(),
        _ => return true,
    };
    let mut matcher = robotstxt::DefaultMatcher::default();
    matcher.one_agent_allowed_by_robots(&body, USER_AGENT, url)
}

/// `scheme://host/robots.txt` for a URL.
fn robots_url_for(url: &str) -> Option<String> {
    let scheme_end = url.find("://")? + 3;
    let rest = &url[scheme_end..];
    let host_end = rest.find('/').map_or(url.len(), |i| scheme_end + i);
    Some(format!("{}/robots.txt", &url[..host_end]))
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
