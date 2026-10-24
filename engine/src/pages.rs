// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Identity and text handling for web pages the browser extension asks about.
//!
//! A page is keyed by a canonical form of its URL, so the same article
//! reached through a tracking link or a trailing slash is one page in Gloss.
//! The key is computed here and nowhere else; the extension only ever
//! receives it.

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use url::Url;

/// Longest readable page text sent to an agent, in characters. Longer pages
/// keep their head and tail.
pub const PAGE_TEXT_MAX_CHARS: usize = 60_000;

/// Query parameters that only track the visit and never change the page.
const TRACKING_PARAMS: &[&str] = &[
    "fbclid",
    "gclid",
    "gclsrc",
    "dclid",
    "msclkid",
    "yclid",
    "twclid",
    "ttclid",
    "igshid",
    "mc_cid",
    "mc_eid",
    "_ga",
    "_gl",
    "_hsenc",
    "_hsmi",
    "mkt_tok",
    "oly_anon_id",
    "oly_enc_id",
    "vero_id",
    "wickedid",
    "s_kwcid",
    "ref_src",
    "spm",
];

/// Canonical key of a page URL. Only http, https and file URLs are pages.
///
/// The scheme and host are lower-cased, user info and a default port are
/// dropped, one trailing slash is removed from a non-root path, tracking
/// parameters (`utm_*` and a fixed list) are dropped and the rest sorted,
/// and the fragment is dropped unless it is a hash route (`#/…` or `#!/…`).
pub fn url_key(raw: &str) -> Result<String> {
    let mut url = Url::parse(raw.trim()).map_err(|e| anyhow!("not a URL: {}", e))?;
    if !matches!(url.scheme(), "http" | "https" | "file") {
        return Err(anyhow!("{} pages cannot be asked about", url.scheme()));
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    let default_port = match url.scheme() {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    };
    if url.port().is_some() && url.port() == default_port {
        let _ = url.set_port(None);
    }
    let path = url.path().to_string();
    if path.len() > 1 && path.ends_with('/') {
        url.set_path(path.trim_end_matches('/'));
    }
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !is_tracking_param(k))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    pairs.sort();
    if pairs.is_empty() {
        url.set_query(None);
    } else {
        let mut q = url.query_pairs_mut();
        q.clear();
        for (k, v) in &pairs {
            q.append_pair(k, v);
        }
        drop(q);
    }
    let keep_fragment = url
        .fragment()
        .is_some_and(|f| f.starts_with('/') || f.starts_with("!/"));
    if !keep_fragment {
        url.set_fragment(None);
    }
    Ok(url.to_string())
}

fn is_tracking_param(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.starts_with("utm_") || TRACKING_PARAMS.contains(&k.as_str())
}

/// The host of a URL, lower-cased, or an empty string when it has none.
pub fn host_of(raw: &str) -> String {
    Url::parse(raw.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default()
}

/// Whether `host` is covered by one of the deny-list patterns. A pattern is
/// a host name (exact match) or `*.example.com`, which matches the apex and
/// every subdomain. Matching ignores case and surrounding whitespace.
pub fn host_matches(patterns: &[String], host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    patterns.iter().any(|p| {
        let p = p.trim().to_ascii_lowercase();
        if p.is_empty() {
            false
        } else if let Some(base) = p.strip_prefix("*.") {
            host == base || host.ends_with(&format!(".{}", base))
        } else {
            host == p
        }
    })
}

/// Hex SHA-256 of a page's text, used to resend it only when it changes.
pub fn page_text_hash(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

/// Caps page text at `PAGE_TEXT_MAX_CHARS` by keeping the first two thirds
/// and the last third, with a marker between them.
pub fn truncate_page_text(text: &str) -> String {
    let total = text.chars().count();
    if total <= PAGE_TEXT_MAX_CHARS {
        return text.to_string();
    }
    let head_len = PAGE_TEXT_MAX_CHARS * 2 / 3;
    let tail_len = PAGE_TEXT_MAX_CHARS - head_len;
    let head: String = text.chars().take(head_len).collect();
    let tail: String = text.chars().skip(total - tail_len).collect();
    format!(
        "{}\n\n[… {} characters omitted …]\n\n{}",
        head.trim_end(),
        total - head_len - tail_len,
        tail.trim_start()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_key_normalises_known_variations() {
        let cases = [
            ("HTTPS://Example.com:443/Docs/", "https://example.com/Docs"),
            ("https://example.com/", "https://example.com/"),
            (
                "https://user:pw@example.com/a?b=2&a=1",
                "https://example.com/a?a=1&b=2",
            ),
            (
                "https://example.com/a?utm_source=x&fbclid=y&q=rust",
                "https://example.com/a?q=rust",
            ),
            (
                "https://example.com/a?utm_source=x",
                "https://example.com/a",
            ),
            ("https://example.com/a#section", "https://example.com/a"),
            (
                "https://app.example.com/#/inbox/3",
                "https://app.example.com/#/inbox/3",
            ),
            (
                "https://app.example.com/#!/old",
                "https://app.example.com/#!/old",
            ),
            ("http://localhost:8080/x", "http://localhost:8080/x"),
            ("file:///Users/me/doc.html", "file:///Users/me/doc.html"),
        ];
        for (input, expected) in cases {
            assert_eq!(url_key(input).unwrap(), expected, "input {}", input);
        }
        assert!(url_key("chrome://extensions").is_err());
        assert!(url_key("not a url").is_err());
    }

    #[test]
    fn host_matching_handles_wildcards() {
        let deny = vec![
            "*.bank.com".to_string(),
            "Mail.Example.org".to_string(),
            "".to_string(),
        ];
        assert!(host_matches(&deny, "bank.com"));
        assert!(host_matches(&deny, "online.bank.com"));
        assert!(!host_matches(&deny, "notbank.com"));
        assert!(host_matches(&deny, "mail.example.org"));
        assert!(!host_matches(&deny, "example.org"));
        assert!(!host_matches(&deny, ""));
        assert_eq!(host_of("https://A.B.com/x"), "a.b.com");
    }

    #[test]
    fn page_text_is_capped_keeping_head_and_tail() {
        let short = "hello";
        assert_eq!(truncate_page_text(short), short);
        let long: String = (0..PAGE_TEXT_MAX_CHARS + 1000)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        let cut = truncate_page_text(&long);
        assert!(cut.chars().count() < PAGE_TEXT_MAX_CHARS + 100);
        assert!(cut.contains("characters omitted"));
        assert!(cut.starts_with(&long[..100]));
        assert!(cut.ends_with(&long[long.len() - 100..]));
        assert_eq!(page_text_hash("a").len(), 64);
    }
}
