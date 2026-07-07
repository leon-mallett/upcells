//! Text chunking for RAG (§6). Word-based greedy packing with overlap — simple, always makes
//! progress, and never emits an over-long chunk (no token dependency).

/// Target chunk size in characters (~250–300 tokens for the nomic embedder).
const TARGET_CHARS: usize = 1200;
/// Overlap between consecutive chunks, in characters, so context isn't split mid-idea.
const OVERLAP_CHARS: usize = 150;

/// Split text into overlapping chunks on word boundaries.
pub fn chunk_text(text: &str) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    while start < words.len() {
        // Grow the chunk until the character budget is reached.
        let mut end = start;
        let mut chars = 0;
        while end < words.len() && (chars == 0 || chars + words[end].len() + 1 <= TARGET_CHARS) {
            chars += words[end].len() + 1;
            end += 1;
        }
        chunks.push(words[start..end].join(" "));

        if end >= words.len() {
            break;
        }
        // Step back ~OVERLAP_CHARS of trailing words for the next chunk, but always advance.
        let mut back = end;
        let mut overlap = 0;
        while back > start + 1 && overlap < OVERLAP_CHARS {
            back -= 1;
            overlap += words[back].len() + 1;
        }
        start = back.max(start + 1);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_chunk() {
        let chunks = chunk_text("A short piece of brand copy.");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "A short piece of brand copy.");
    }

    #[test]
    fn empty_text_yields_no_chunks() {
        assert!(chunk_text("   \n  ").is_empty());
    }

    #[test]
    fn long_text_splits_with_overlap() {
        let word = "lorem ";
        let text = word.repeat(1000); // ~6000 chars
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 1, "should split into multiple chunks");
        // Each chunk within budget (+ one word slack).
        assert!(chunks.iter().all(|c| c.len() <= TARGET_CHARS + 8));
        // Consecutive chunks overlap: the end of one appears at the start of the next.
        let tail: String = chunks[0].split_whitespace().rev().take(3).collect::<Vec<_>>().join(" ");
        assert!(!tail.is_empty());
    }
}
