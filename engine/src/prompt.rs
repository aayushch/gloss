//! Text Gloss adds around what the user types before it reaches an agent.

use crate::types::AgentId;

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

/// The parts of the artifact convention the UI parser depends on, kept here so
/// a test fails if the note stops mentioning them.
pub const ARTIFACT_TAG: &str = "<artifact id=";

/// Agents whose CLI accepts a system prompt flag. The others get the note
/// prepended to the first turn's prompt instead.
pub fn has_system_prompt_flag(agent: AgentId) -> bool {
    matches!(agent, AgentId::Claude | AgentId::Pi)
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
pub fn compose_prompt(agent: AgentId, is_first_turn: bool, body: &str) -> String {
    if is_first_turn && !has_system_prompt_flag(agent) {
        format!("{}\n\n{}", SYSTEM_NOTE, body)
    } else {
        body.to_string()
    }
}

/// Conversation title derived from the first user message: the first line,
/// cut to `max` characters on a word boundary.
pub fn title_from_message(text: &str, max: usize) -> String {
    let first_line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let cleaned: String = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= max {
        return if cleaned.is_empty() { "New conversation".to_string() } else { cleaned };
    }
    let cut: String = cleaned.chars().take(max).collect();
    let base = match cut.rfind(' ') {
        Some(i) if i > max / 2 => &cut[..i],
        _ => &cut,
    };
    format!("{}…", base.trim_end_matches(|c: char| c.is_ascii_punctuation() || c == ' '))
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
        assert!(compose_prompt(AgentId::Codex, true, "hi").starts_with(SYSTEM_NOTE));
        assert_eq!(compose_prompt(AgentId::Codex, false, "hi"), "hi");
        assert_eq!(compose_prompt(AgentId::Claude, true, "hi"), "hi");
    }

    #[test]
    fn system_note_describes_artifacts() {
        assert!(SYSTEM_NOTE.contains(ARTIFACT_TAG));
        assert!(SYSTEM_NOTE.contains("</artifact>"));
        for ty in ["text/html", "image/svg+xml", "text/mermaid", "text/markdown", "text/plain", "text/code"] {
            assert!(SYSTEM_NOTE.contains(ty), "{} missing", ty);
        }
    }

    #[test]
    fn title_cuts_on_word_boundary() {
        let t = title_from_message("How do CPUs actually implement atomic compare-and-swap, and how do locks build on it?", 60);
        assert_eq!(t, "How do CPUs actually implement atomic compare-and-swap, and…");
        assert_eq!(title_from_message("short", 60), "short");
        assert_eq!(title_from_message("  \n  ", 60), "New conversation");
    }
}
