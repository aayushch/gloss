// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Attachment handling: deciding what kind of file the user attached, naming
//! its stored copy, and turning text attachments into prompt text.

use std::path::Path;

use crate::types::AttachmentKind;

/// Largest image accepted, in bytes. Agents send images to their model
/// inline, so very large files mostly cost tokens and time.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Largest text file accepted, in bytes; the whole file is inlined into the
/// prompt, so this bounds the prompt size.
pub const MAX_TEXT_BYTES: u64 = 512 * 1024;

const IMAGE_MIMES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

const IMAGE_EXTS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

/// The file's kind and the mime type to record for it, or None when Gloss
/// cannot send this file to an agent. Images are recognised by mime type or
/// extension; anything else counts as text when its first bytes decode as
/// UTF-8 without NUL bytes.
pub fn classify(name: &str, mime: &str, bytes: &[u8]) -> Option<(AttachmentKind, String)> {
    let mime = mime.trim().to_lowercase();
    if let Some((m, _)) = IMAGE_MIMES.iter().find(|(m, _)| *m == mime) {
        return Some((AttachmentKind::Image, m.to_string()));
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if let Some((_, m)) = IMAGE_EXTS.iter().find(|(e, _)| *e == ext) {
        return Some((AttachmentKind::Image, m.to_string()));
    }
    if looks_like_text(bytes) {
        let m = if mime.starts_with("text/") || mime.contains("json") || mime.contains("xml") {
            mime
        } else {
            "text/plain".to_string()
        };
        return Some((AttachmentKind::Text, m));
    }
    None
}

fn looks_like_text(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(64 * 1024)];
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        // A multi-byte character may be cut at the sample boundary.
        Err(e) => e.valid_up_to() + 4 >= head.len(),
    }
}

/// A file name that is safe to put in a path and in an agent prompt: ASCII
/// letters, digits, dot, dash and underscore only, at most 80 characters.
pub fn safe_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let mut out: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    while out.starts_with('.') {
        out.remove(0);
    }
    if out.len() > 80 {
        let ext = Path::new(&out)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e))
            .unwrap_or_default();
        let keep = 80 - ext.len();
        out = format!("{}{}", &out[..keep], ext);
    }
    if out.is_empty() {
        "file".to_string()
    } else {
        out
    }
}

/// Prompt text for one inlined text attachment.
pub fn inline_text(name: &str, contents: &str) -> String {
    format!(
        "<attachment name=\"{}\">\n{}\n</attachment>",
        name,
        contents.trim_end_matches('\n')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_mime_extension_and_content() {
        assert_eq!(
            classify("a.bin", "image/png", b"x"),
            Some((AttachmentKind::Image, "image/png".into()))
        );
        assert_eq!(
            classify("Photo.JPG", "", b"x"),
            Some((AttachmentKind::Image, "image/jpeg".into()))
        );
        assert_eq!(
            classify("main.rs", "", b"fn main() {}"),
            Some((AttachmentKind::Text, "text/plain".into()))
        );
        assert_eq!(
            classify("d.json", "application/json", b"{}"),
            Some((AttachmentKind::Text, "application/json".into()))
        );
        assert_eq!(classify("x.pdf", "application/pdf", b"%PDF\0\x01"), None);
    }

    #[test]
    fn safe_names_strip_paths_and_odd_characters() {
        assert_eq!(safe_name("/tmp/my file (1).txt"), "my_file__1_.txt");
        assert_eq!(safe_name("..hidden"), "hidden");
        assert_eq!(safe_name(""), "file");
        let long = format!("{}.md", "a".repeat(100));
        assert_eq!(safe_name(&long).len(), 80);
        assert!(safe_name(&long).ends_with(".md"));
    }
}
