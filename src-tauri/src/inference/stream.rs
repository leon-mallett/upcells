//! Streaming to the frontend via Tauri events (§2.4).
//!
//! One event name per conversation keeps multiple chats isolated. Tokens arrive as
//! [`StreamChunk`] deltas on `chat:stream:{id}`; a terminal `chat:complete:{id}` carries the
//! final persisted message.
//!
//! **Gotcha:** Tauri 2 restricts characters in event names, and ids can contain dots
//! (`qwen3.5-4b`, model ids used in `model:download:{id}`). Any dynamic segment must be
//! sanitised via [`sanitise_segment`] or event routing silently breaks.

use serde::Serialize;

/// One streamed token (or small run of tokens) for the UI to append.
#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub message_id: String,
    pub delta: String,
    pub done: bool,
}

/// Terminal payload for `chat:complete:{id}` — the fully assembled message.
#[derive(Debug, Clone, Serialize)]
pub struct GenerationComplete {
    pub message_id: String,
    pub text: String,
}

/// Replace any character that isn't `[A-Za-z0-9_-]` with `_`, so a dynamic id is safe to
/// embed in a Tauri event name.
pub fn sanitise_segment(segment: &str) -> String {
    segment
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Per-conversation token stream event name.
pub fn stream_event(conversation_id: &str) -> String {
    format!("chat:stream:{}", sanitise_segment(conversation_id))
}

/// Per-conversation terminal event name.
pub fn complete_event(conversation_id: &str) -> String {
    format!("chat:complete:{}", sanitise_segment(conversation_id))
}

/// Per-model download-progress event name.
pub fn download_event(model_id: &str) -> String {
    format!("model:download:{}", sanitise_segment(model_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotted_model_id_is_sanitised() {
        assert_eq!(sanitise_segment("qwen3.5-4b"), "qwen3_5-4b");
        assert_eq!(download_event("qwen3.5-4b"), "model:download:qwen3_5-4b");
    }

    #[test]
    fn keeps_safe_characters() {
        assert_eq!(sanitise_segment("conv_123-abc"), "conv_123-abc");
    }

    #[test]
    fn replaces_slashes_and_spaces() {
        assert_eq!(sanitise_segment("a/b c"), "a_b_c");
    }
}
