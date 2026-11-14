// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Identity and text handling for web pages the browser extension asks about.
//!
//! A page is keyed by a canonical form of its URL, so the same article
//! reached through a tracking link or a trailing slash is one page in Gloss.
//! A URL fragment that is not a hash route does not make a new page. It
//! selects a view of the page instead, such as one file of a diff or one
//! section of an article, and the view has its own key. Both keys are
//! computed here and nowhere else; the extension only ever receives them.

use anyhow::{anyhow, Result};
use percent_encoding::percent_decode_str;
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

/// The keys Gloss derives from a browser URL.
#[derive(Clone, Debug, PartialEq)]
pub struct PageKeys {
    /// Canonical key of the page. One page has one entry under Pages and
    /// one conversation.
    pub url_key: String,
    /// Key of the view of the page the URL shows. It is `url_key` followed
    /// by `#` and the decoded fragment when the URL has a fragment that is
    /// not part of `url_key`, and equal to `url_key` otherwise.
    pub view_key: String,
    /// The URL as the browser gave it, without the fragment when the
    /// fragment selects a view. This is the address Gloss shows and opens
    /// for the page as a whole.
    pub page_url: String,
}

/// Derives the page key and the view key of a URL. Only http, https and
/// file URLs are pages.
///
/// For the page key, the scheme and host are lower-cased, user info and a
/// default port are dropped, one trailing slash is removed from a non-root
/// path, and tracking parameters (`utm_*` and a fixed list) are dropped and
/// the rest sorted. A fragment that is a hash route (`#/…` or `#!/…`) stays
/// in the page key, because single-page apps use it as the path of the
/// page. Any other fragment is left out of the page key and goes into the
/// view key, percent-decoded, so `#a%2Fb` and `#a/b` name the same view. A
/// text directive (`:~:text=…`) only scrolls the page and is dropped.
pub fn page_keys(raw: &str) -> Result<PageKeys> {
    let mut url = Url::parse(raw.trim()).map_err(|e| anyhow!("not a URL: {}", e))?;
    if !matches!(url.scheme(), "http" | "https" | "file") {
        return Err(anyhow!("{} pages cannot be asked about", url.scheme()));
    }
    let fragment = url.fragment().unwrap_or("").to_string();
    let fragment = match fragment.find(":~:") {
        Some(at) => fragment[..at].to_string(),
        None => fragment,
    };
    let is_route = fragment.starts_with('/') || fragment.starts_with("!/");
    url.set_fragment(if is_route { Some(&fragment) } else { None });
    let page_url = url.to_string();

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
    let url_key = url.to_string();
    let view_key = if is_route || fragment.is_empty() {
        url_key.clone()
    } else {
        let decoded = percent_decode_str(&fragment).decode_utf8_lossy();
        format!("{}#{}", url_key, decoded)
    };
    Ok(PageKeys {
        url_key,
        view_key,
        page_url,
    })
}

/// Canonical key of a page URL (see `page_keys`).
pub fn url_key(raw: &str) -> Result<String> {
    Ok(page_keys(raw)?.url_key)
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
    fn a_fragment_selects_a_view_of_the_page() {
        // Two files of one diff: one page, two views.
        let a =
            page_keys("https://git.example.com/pr/7/diff/?utm_source=x#src%2FFoo.java").unwrap();
        let b = page_keys("https://git.example.com/pr/7/diff#src/Bar.java").unwrap();
        assert_eq!(a.url_key, "https://git.example.com/pr/7/diff");
        assert_eq!(a.url_key, b.url_key);
        assert_eq!(a.view_key, "https://git.example.com/pr/7/diff#src/Foo.java");
        assert_eq!(b.view_key, "https://git.example.com/pr/7/diff#src/Bar.java");
        // The page URL keeps what the browser sent, minus the view fragment.
        assert_eq!(
            a.page_url,
            "https://git.example.com/pr/7/diff/?utm_source=x"
        );

        // The encoded and the plain spelling of a fragment are one view.
        assert_eq!(
            page_keys("https://git.example.com/pr/7/diff#src/Foo.java")
                .unwrap()
                .view_key,
            a.view_key
        );

        // No fragment, an empty one and a text directive are the page itself.
        for url in [
            "https://example.com/a",
            "https://example.com/a#",
            "https://example.com/a#:~:text=hello",
        ] {
            let k = page_keys(url).unwrap();
            assert_eq!(k.view_key, "https://example.com/a", "url {}", url);
            assert_eq!(k.url_key, "https://example.com/a", "url {}", url);
        }
        assert_eq!(
            page_keys("https://example.com/a#notes:~:text=hello")
                .unwrap()
                .view_key,
            "https://example.com/a#notes"
        );

        // A hash route is part of the page, so the view is the page.
        let route = page_keys("https://app.example.com/#/inbox/3").unwrap();
        assert_eq!(route.url_key, "https://app.example.com/#/inbox/3");
        assert_eq!(route.view_key, route.url_key);
        assert_eq!(route.page_url, "https://app.example.com/#/inbox/3");
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
