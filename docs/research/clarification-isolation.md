# Research: keeping clarifications out of the main context

Status: research only, nothing implemented. Written 2026-10-14.

## What happens today

Every turn, main-column or clarification, resumes the conversation's single
agent session. The agent sees one linear history in which a clarification is
just the next message, wrapped by `prompt::clarification_prompt`. Gloss's own
store tags the pair with a clarification id and renders it in a well. So the
main context grows with every well, and a later main-column question is
answered with the wells in the agent's memory.

## The alternative: isolated clarifications

An isolated clarification runs in a session the main thread never sees. It
needs the conversation as context, which can come from two places:

1. **Fork the main session** where the CLI allows it. The fork starts with
   the exact main history (and, for Claude, the same prompt cache), then
   diverges. Follow-ups inside the well resume the fork.
2. **Replay the transcript** as a prompt: Gloss already stores every turn, so
   it can compose "Here is the conversation so far … The user highlighted …"
   and start a fresh session. Works for every agent; costs input tokens
   proportional to the conversation length on every new well.

What each installed CLI offers (checked 2026-10-14):

| Agent | Fork support | Route for an isolated well |
| --- | --- | --- |
| Claude Code | `--resume <main> --fork-session` creates a new session id from the main history | Fork. Follow-ups: `--resume <fork id>`. |
| Pi | `--fork <id>` | Fork. |
| Codex CLI | `codex fork` is an interactive command; `codex exec` has only `resume` | Replay the transcript into a new thread. |
| Gemini CLI | No fork flag, but `--session-file <json>` loads a session from a file | Copy the main session file, load it with a new `--session-id`: a fork by file copy. Needs a test once the API key works. Fallback: replay. |
| Cursor Agent | None | Replay the transcript. |

Replay is the universal fallback and the fork is an optimisation, so the
engine should implement replay first and add forks per agent.

### Engine changes

- `clarifications` gains `isolated INTEGER` and `agent_session_id TEXT`. A
  well with its own session id is resumed for follow-ups; nested wells fork or
  replay from their parent well, not from the main thread.
- The "one process per conversation" lock becomes one process per session.
  An isolated well can then run while the main agent is still answering,
  which is a real usability gain: today a clarification waits for the main
  turn to finish.
- The replay prompt needs a size cap. Beyond it, Gloss sends the most recent
  turns plus the anchor turn in full and summarises nothing (summaries would
  need another agent call). A visible "context truncated" note on the well is
  enough.
- Cost accounting: the meta line under an isolated reply should say "separate
  context" so the token counts make sense.

## Global setting or per-clarification toggle

### Global (Settings sheet, "Clarifications: share context / separate context")

Pros:
- One mental model per user. Either the agent remembers your wells or it
  never does; nothing to think about when asking.
- Simplest UI: no extra control in the inline composer.
- Easy to reason about what a later main-column question can refer to.

Cons:
- The right answer differs by question. "What does this term mean" wants
  isolation; "Revise the plan above with this constraint" wants the main
  thread to remember the exchange. A global choice is wrong for one of them.
- Switching the setting mid-conversation leaves earlier wells in the other
  mode, so the conversation's history is mixed anyway.

### Per clarification (toggle in the inline composer)

Pros:
- The decision is made where the information is: the user knows, while
  typing, whether this is a side question or part of the main line.
- Isolated wells can run concurrently with the main turn; the user can see
  that affordance on the toggle itself ("asks in a separate context, can run
  while the agent is busy").

Cons:
- One more control on every ask. Most users will leave it at the default.
- Mixed state in one conversation. The user has to remember which wells the
  main agent knows about. Needs a visible marker on isolated wells (an icon in
  the well header and in the rail item) so the state is never invisible.
- Follow-ups inside a well inherit the well's mode; they cannot switch,
  because the well's session is either the main one or its own.

### Recommendation

Both, layered: a global default in Settings and a per-clarification override
in the inline composer that starts on the default. Isolated wells carry a
marker. Later, a "Promote to main thread" action can re-send an isolated
exchange into the main session when it turns out to matter. Default value:
share context, because that is what every chat product does and what users
expect; the setting is for people who already feel the pollution.

Effort: small for the store and UI, medium for the engine (session-level
locking, replay composer, per-agent fork). The user-visible part is a toggle
and a marker.
