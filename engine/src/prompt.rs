// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Text Gloss adds around what the user types before it reaches an agent.

use crate::types::{AgentId, AskContext};

/// Short framing note given to every agent as (an addition to) its system
/// prompt, so a coding agent answers like a chat assistant.
pub const SYSTEM_NOTE: &str = "You are talking to the user through Gloss, a desktop chat app. \
Answer in GitHub-flavored markdown. You have no project or filesystem to work on: \
do not offer to read, edit or create files, and do not propose running commands. \
When the user quotes an excerpt of your earlier answer, answer about that excerpt directly.\n\n\
When the user asks for a substantial piece of work that stands on its own, such as a web page, an SVG drawing, \
a Mermaid diagram, a document, a script or a complete source file of more than about fifteen lines, \
write it as an artifact instead of a code fence. Gloss shows artifacts in a side panel with a preview. \
An artifact looks like this, with nothing wrapped around it:\n\n\
<artifact id=\"short-kebab-id\" type=\"text/html\" title=\"Short title\">\n\
...the complete content...\n\
</artifact>\n\n\
Allowed types: text/html for a complete page, image/svg+xml, text/mermaid, text/markdown, text/plain, \
or text/code with an extra lang=\"...\" attribute naming the language. \
Keep short snippets, examples and explanations in ordinary markdown. \
To change an artifact later, send the whole artifact again with the same id; Gloss records it as a new version. \
Never put an artifact inside a code fence.";

/// The system note for a conversation. Bound to a project folder, the agent
/// is told where it runs and that the user decides, through Gloss, what it
/// may change: the note itself says nothing about editing, because Claude
/// Code keeps the system prompt from the first turn of a session and the
/// mode can change on any later turn. The tools on offer and the permission
/// mode carry that decision instead.
pub fn system_note(project_dir: Option<&str>) -> String {
    match project_dir {
        None => SYSTEM_NOTE.to_string(),
        Some(dir) => SYSTEM_NOTE.replace(
            "You have no project or filesystem to work on: \
do not offer to read, edit or create files, and do not propose running commands. ",
            &format!(
                "You are working inside the user's project folder {}, which is your working directory. \
Read its files whenever that helps answer the question, and say which files you looked at. \
The user chooses in Gloss what you may change: when a tool is unavailable or a call is refused, \
you cannot do that right now, so say so briefly instead of trying another way. \
When a call needs approval, the user sees it and decides; when you need a decision from the user, ask. ",
                dir
            ),
        ),
    }
}

/// The parts of the artifact convention the UI parser depends on, kept here so
/// a test fails if the note stops mentioning them.
pub const ARTIFACT_TAG: &str = "<artifact id=";

/// Agents whose CLI accepts a system prompt flag. The others get the note
/// prepended to the first turn's prompt instead.
pub fn has_system_prompt_flag(agent: AgentId) -> bool {
    matches!(agent, AgentId::Claude | AgentId::Pi)
}

/// The system note for a conversation that belongs to a web page: the agent
/// is told it answers about a page open in the user's browser.
pub fn page_system_note(title: &str, url: &str) -> String {
    SYSTEM_NOTE.replace(
        "You have no project or filesystem to work on: \
do not offer to read, edit or create files, and do not propose running commands. ",
        &format!(
            "The user is reading a web page in their browser and asking about it through the Gloss browser extension. \
The page is \"{}\" at {}. Each question quotes the passage the user highlighted, with the text around it; \
the page's readable text is included with the first question and again whenever it changes. \
Answer about the highlighted passage directly and briefly, in markdown. \
You have no files to work on and cannot open other pages unless you have a web tool. ",
            title.trim(),
            url.trim()
        ),
    )
}

/// What a question about a highlighted passage of a web page becomes when
/// sent to the agent. `page_text` is included when the page's text is new
/// to the conversation; `page_changed` says it replaces an earlier copy.
pub fn page_ask_prompt(
    quote: &str,
    context: &AskContext,
    question: &str,
    page_text: Option<&str>,
    page_changed: bool,
) -> String {
    let mut p = format!(
        "The user highlighted this passage on the page and is asking about it.\n\
Answer about the passage directly, in markdown, without summarising the whole page.\n\n\
> \"{}\"\n",
        quote.trim()
    );
    let before = context.before.trim();
    let after = context.after.trim();
    if !before.is_empty() {
        p.push_str(&format!("\nText just before it: \"…{}\"\n", before));
    }
    if !after.is_empty() {
        p.push_str(&format!("\nText just after it: \"{}…\"\n", after));
    }
    p.push('\n');
    p.push_str(question.trim());
    append_page_text(&mut p, page_text, page_changed);
    p
}

/// A question about the page as a whole, with no highlighted passage.
pub fn page_question_prompt(question: &str, page_text: Option<&str>, page_changed: bool) -> String {
    let mut p = format!(
        "The user is asking about the page as a whole.\n\n{}",
        question.trim()
    );
    append_page_text(&mut p, page_text, page_changed);
    p
}

fn append_page_text(p: &mut String, page_text: Option<&str>, page_changed: bool) {
    if let Some(text) = page_text {
        p.push_str("\n\n---\nThe page's readable text");
        if page_changed {
            p.push_str(", which has changed since last time");
        }
        p.push_str(":\n<page>\n");
        p.push_str(text.trim());
        p.push_str("\n</page>");
    }
}

/// What a clarification question becomes when sent to the agent.
pub fn clarification_prompt(quote: &str, question: &str) -> String {
    format!(
        "The user highlighted this excerpt of your previous answer and is asking about it.\n\
Answer about the excerpt directly, in markdown, without repeating the whole answer.\n\n\
> \"{}\"\n\n{}",
        quote.trim(),
        question.trim()
    )
}

/// A later question inside the same clarification thread.
pub fn follow_up_prompt(quote: &str, question: &str) -> String {
    format!(
        "Follow-up about the excerpt \"{}\":\n\n{}",
        truncate(quote.trim(), 80),
        question.trim()
    )
}

/// Final prompt for one turn: the body, with the system note prepended on the
/// first turn for agents that have no system prompt flag.
pub fn compose_prompt(agent: AgentId, is_first_turn: bool, body: &str, note: &str) -> String {
    if is_first_turn && !has_system_prompt_flag(agent) {
        format!("{}\n\n{}", note, body)
    } else {
        body.to_string()
    }
}

/// Conversation title derived from the first user message: the first line,
/// cut to `max` characters on a word boundary.
pub fn title_from_message(text: &str, max: usize) -> String {
    let first_line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let cleaned: String = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= max {
        return if cleaned.is_empty() {
            "New conversation".to_string()
        } else {
            cleaned
        };
    }
    let cut: String = cleaned.chars().take(max).collect();
    let base = match cut.rfind(' ') {
        Some(i) if i > max / 2 => &cut[..i],
        _ => &cut,
    };
    format!(
        "{}…",
        base.trim_end_matches(|c: char| c.is_ascii_punctuation() || c == ' ')
    )
}

/// Shorten with an ellipsis on a character boundary.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{}…", cut.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clarification_prompt_quotes_and_asks() {
        let p = clarification_prompt("  the store buffer ", "Who reorders?");
        assert!(p.starts_with("The user highlighted this excerpt"));
        assert!(p.contains("> \"the store buffer\"\n\nWho reorders?"));
    }

    #[test]
    fn follow_up_prompt_truncates_long_quotes() {
        let quote = "x".repeat(200);
        let p = follow_up_prompt(&quote, "why?");
        assert!(p.contains(&format!("\"{}…\"", "x".repeat(80))));
        assert!(p.ends_with("why?"));
    }

    #[test]
    fn system_note_only_on_first_turn_without_flag() {
        assert!(compose_prompt(AgentId::Codex, true, "hi", SYSTEM_NOTE).starts_with(SYSTEM_NOTE));
        assert_eq!(
            compose_prompt(AgentId::Codex, false, "hi", SYSTEM_NOTE),
            "hi"
        );
        assert_eq!(
            compose_prompt(AgentId::Claude, true, "hi", SYSTEM_NOTE),
            "hi"
        );
    }

    #[test]
    fn system_note_describes_artifacts() {
        assert!(SYSTEM_NOTE.contains(ARTIFACT_TAG));
        assert!(SYSTEM_NOTE.contains("</artifact>"));
        for ty in [
            "text/html",
            "image/svg+xml",
            "text/mermaid",
            "text/markdown",
            "text/plain",
            "text/code",
        ] {
            assert!(SYSTEM_NOTE.contains(ty), "{} missing", ty);
        }
    }

    #[test]
    fn project_note_names_the_folder_and_keeps_artifacts() {
        let note = system_note(Some("/home/me/app"));
        assert!(note.contains("/home/me/app"));
        assert!(!note.contains("no project or filesystem"));
        assert!(note.contains(ARTIFACT_TAG));
        assert_eq!(system_note(None), SYSTEM_NOTE);
    }

    #[test]
    fn page_ask_prompt_quotes_context_and_page_text() {
        let ctx = AskContext {
            before: "the cache ".into(),
            after: " is flushed".into(),
        };
        let p = page_ask_prompt("store buffer", &ctx, "Why?", Some("Full page"), false);
        assert!(p.starts_with("The user highlighted this passage on the page"));
        assert!(p.contains("> \"store buffer\""));
        assert!(p.contains("Text just before it: \"…the cache\""));
        assert!(p.contains("Text just after it: \"is flushed…\""));
        assert!(p.contains("\nWhy?\n\n---\nThe page's readable text:\n<page>\nFull page\n</page>"));
        let again = page_ask_prompt("x", &AskContext::default(), "q", Some("New"), true);
        assert!(again.contains("which has changed since last time"));
        assert!(!again.contains("Text just before"));
        let none = page_ask_prompt("x", &AskContext::default(), "q", None, false);
        assert!(!none.contains("<page>"));
        assert!(none.ends_with("q"));
        assert!(page_question_prompt("what is this", None, false).ends_with("what is this"));
    }

    #[test]
    fn page_note_names_the_page_and_keeps_artifacts() {
        let note = page_system_note("Rust Book", "https://doc.rust-lang.org/book/");
        assert!(note.contains("\"Rust Book\" at https://doc.rust-lang.org/book/"));
        assert!(!note.contains("no project or filesystem"));
        assert!(note.contains(ARTIFACT_TAG));
    }

    #[test]
    fn title_cuts_on_word_boundary() {
        let t = title_from_message(
            "How do CPUs actually implement atomic compare-and-swap, and how do locks build on it?",
            60,
        );
        assert_eq!(
            t,
            "How do CPUs actually implement atomic compare-and-swap, and…"
        );
        assert_eq!(title_from_message("short", 60), "short");
        assert_eq!(title_from_message("  \n  ", 60), "New conversation");
    }
}
