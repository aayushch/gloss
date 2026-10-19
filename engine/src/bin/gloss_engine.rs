//! Command line front end for the Gloss engine, for driving the real agents
//! without the desktop app. Honours `GLOSS_HOME`.

use std::io::Write;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use gloss_engine::*;

#[derive(Parser)]
#[command(name = "gloss-engine", about = "Headless Gloss engine")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Detect installed agents.
    Agents,
    /// List models for an agent.
    Models { agent: String },
    /// Print the captured PATH and where each agent binary resolves.
    Env,
    /// Create a conversation and print its id.
    New {
        #[arg(long)]
        agent: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        no_web: bool,
        /// Run the agent inside this folder with read-only file tools.
        #[arg(long)]
        project: Option<String>,
        /// Working mode inside the project folder (an id from `agents`); read-only when omitted.
        #[arg(long)]
        mode: Option<String>,
    },
    /// Change the working mode of a project-bound conversation (`read-only` to go back).
    Mode { conversation: String, mode: String },
    /// Send a turn and stream the reply.
    Send {
        conversation: String,
        text: String,
        /// Start a clarification anchored to this quoted text.
        #[arg(long)]
        quote: Option<String>,
        /// Block id the quote lives in (`<turnId>:<index>`), used with --quote.
        #[arg(long)]
        block: Option<String>,
        /// Follow up inside an existing clarification.
        #[arg(long)]
        clarification: Option<String>,
        /// Attach a file (image or text); repeatable.
        #[arg(long = "attach")]
        attach: Vec<std::path::PathBuf>,
        /// Answer the agent's requests without asking: allow every tool call
        /// and pick the first option of every question.
        #[arg(long)]
        auto_answer: bool,
    },
    /// Full-text search across every conversation.
    Search { query: String },
    /// Pin or unpin a conversation.
    Pin {
        conversation: String,
        #[arg(long)]
        off: bool,
    },
    /// Replace a conversation's tags.
    Tag { conversation: String, tags: Vec<String> },
    /// Cancel a running turn.
    Cancel { conversation: String },
    /// List conversations.
    List {
        #[arg(long)]
        query: Option<String>,
        #[arg(long)]
        tag: Option<String>,
    },
    /// Print a conversation's turns and clarifications.
    Show { conversation: String },
    /// List the agent sessions recorded for a folder outside Gloss.
    Sessions { folder: String },
    /// Print the turns of one of those sessions.
    Session { folder: String, agent: String, id: String },
    /// Continue one of those sessions in a new conversation and print its id.
    Continue { folder: String, agent: String, id: String },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    let paths = GlossPaths::from_env();
    let engine = Arc::new(Engine::open(paths.clone())?);
    eprintln!("gloss home: {}", paths.home.display());

    match cli.cmd {
        Cmd::Agents => {
            for a in engine.list_agents() {
                println!(
                    "{:<8} {:<12} {:<6} {:<10} {}",
                    a.id,
                    a.name,
                    if a.available { "yes" } else { "no" },
                    a.version.unwrap_or_else(|| "-".into()),
                    a.path.unwrap_or_default()
                );
            }
        }
        Cmd::Models { agent } => {
            let id = AgentId::parse(&agent).ok_or_else(|| anyhow!("unknown agent {}", agent))?;
            for m in engine.list_models(id) {
                println!(
                    "{}{:<40} {:<28} {:<8} {}",
                    if m.is_default { "*" } else { " " },
                    m.id,
                    m.name,
                    m.context.unwrap_or_default(),
                    m.note.unwrap_or_default()
                );
            }
        }
        Cmd::Env => {
            println!("PATH={}", engine.env.path());
            for id in AgentId::ALL {
                let info = agents::adapter_for(id).info(&engine.env);
                println!("{:<8} {}", id, info.path.unwrap_or_else(|| "(not found)".into()));
            }
        }
        Cmd::New { agent, model, no_web, project, mode } => {
            let id = AgentId::parse(&agent).ok_or_else(|| anyhow!("unknown agent {}", agent))?;
            let conv = engine.create_conversation(id, model, Some(!no_web), project)?;
            if mode.is_some() {
                engine.set_conversation_mode(&conv.summary.id, mode)?;
            }
            println!("{}", conv.summary.id);
        }
        Cmd::Mode { conversation, mode } => {
            let s = engine.set_conversation_mode(&conversation, Some(mode))?;
            println!("{} mode={}", s.id, s.mode.unwrap_or_else(|| "read-only".into()));
        }
        Cmd::Search { query } => {
            for h in engine.search(&query)? {
                let snippet = h.snippet.replace('\u{1}', "[").replace('\u{2}', "]").replace('\n', " ");
                println!("{}  {:<40} {:<12} {}", h.conversation_id, h.title, h.turn_id.unwrap_or_default(), snippet);
            }
        }
        Cmd::Pin { conversation, off } => {
            let s = engine.set_pinned(&conversation, !off)?;
            println!("{} pinned={}", s.id, s.pinned);
        }
        Cmd::Tag { conversation, tags } => {
            let s = engine.set_tags(&conversation, &tags)?;
            println!("{} tags={}", s.id, s.tags.join(","));
        }
        Cmd::Send { conversation, text, quote, block, clarification, attach, auto_answer } => {
            let mut attachments = Vec::new();
            for path in attach {
                let bytes = std::fs::read(&path)?;
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let att = engine.add_attachment(&name, "", &bytes)?;
                eprintln!("attached {} ({:?}, {} bytes) as {}", att.name, att.kind, att.size, att.id);
                attachments.push(att.id);
            }
            let target = match (quote, block, clarification) {
                (Some(q), Some(b), _) => Some(ClarificationTarget::New { anchor_block_id: b, quote: q, parent_id: None }),
                (_, _, Some(c)) => Some(ClarificationTarget::Existing { clarification_id: c }),
                (Some(_), None, _) => return Err(anyhow!("--quote needs --block")),
                _ => None,
            };
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<TurnEventEnvelope>();
            let sink: engine::EventSink = Arc::new(move |e| {
                let _ = tx.send(e);
            });
            let res = engine
                .send_turn(SendTurnRequest { conversation_id: conversation, text, clarification: target, attachments }, sink)
                .await?;
            eprintln!("user turn {}  assistant turn {}", res.user_turn.id, res.assistant_turn.id);
            if let Some(cl) = res.clarification {
                eprintln!("clarification {} #{}", cl.id, cl.number);
            }
            let mut out = std::io::stdout();
            while let Some(env) = rx.recv().await {
                match env.event {
                    TurnEvent::Started { session_id, model } => {
                        eprintln!("[started] session={} model={}", session_id.unwrap_or_default(), model.unwrap_or_default())
                    }
                    TurnEvent::Delta { text } => {
                        out.write_all(text.as_bytes())?;
                        out.flush()?;
                    }
                    TurnEvent::Replace { text } => {
                        eprintln!("\n[replace]");
                        out.write_all(text.as_bytes())?;
                        out.flush()?;
                    }
                    TurnEvent::Activity { kind, label } => eprintln!("[{:?}] {}", kind, label),
                    TurnEvent::Request { request } => {
                        eprintln!("[request] {}", serde_json::to_string(&request).unwrap_or_default());
                        if !auto_answer {
                            eprintln!("[request] waiting; rerun with --auto-answer or answer from the app");
                            continue;
                        }
                        let answer = match &request.kind {
                            RequestKind::Permission { .. } => RequestAnswer::Permission { allow: true, message: None, set_mode: None },
                            RequestKind::Question { questions } => RequestAnswer::Question {
                                answers: questions
                                    .iter()
                                    .map(|q| (q.question.clone(), q.options.first().map(|o| o.label.clone()).unwrap_or_else(|| "yes".into())))
                                    .collect(),
                            },
                        };
                        engine.answer_request(&env.conversation_id, &request.id, answer)?;
                    }
                    TurnEvent::RequestResolved { request_id } => eprintln!("[request] {} answered", request_id),
                    TurnEvent::Done { turn } => {
                        println!();
                        eprintln!(
                            "[done] model={} usage={}",
                            turn.model.unwrap_or_default(),
                            serde_json::to_string(&turn.usage).unwrap_or_default()
                        );
                        break;
                    }
                    TurnEvent::Failed { error, .. } => {
                        println!();
                        eprintln!("[failed] {}", error);
                        std::process::exit(1);
                    }
                    TurnEvent::Cancelled { .. } => {
                        println!();
                        eprintln!("[cancelled]");
                        break;
                    }
                }
            }
        }
        Cmd::Cancel { conversation } => engine.cancel_turn(&conversation),
        Cmd::List { query, tag } => {
            for c in engine.list_conversations(query.as_deref(), tag.as_deref())? {
                println!("{}  {:<8} {:<20} {:>2} clarifications  {}", c.id, c.agent, c.model, c.clarification_count, c.title);
            }
        }
        Cmd::Sessions { folder } => {
            for s in engine.list_project_sessions(&folder)? {
                let when = chrono::DateTime::from_timestamp_millis(s.updated_at).map(|t| t.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default();
                println!("{}  {:<7} {:<9} {:<38} {}", when, s.agent, format!("{:?}", s.origin), s.id, s.title);
            }
        }
        Cmd::Session { folder, agent, id } => {
            let agent = AgentId::parse(&agent).ok_or_else(|| anyhow::anyhow!("unknown agent {}", agent))?;
            for t in engine.read_project_session(&folder, agent, &id)? {
                println!("--- {:?}{}", t.role, if t.tools.is_empty() { String::new() } else { format!("  [{}]", t.tools.join(" · ")) });
                println!("{}", t.text);
            }
        }
        Cmd::Continue { folder, agent, id } => {
            let agent = AgentId::parse(&agent).ok_or_else(|| anyhow::anyhow!("unknown agent {}", agent))?;
            let c = engine.continue_project_session(&folder, agent, &id)?;
            println!("{}", c.summary.id);
        }
        Cmd::Show { conversation } => {
            let c = engine.get_conversation(&conversation)?;
            println!("{} [{} {}] session={}", c.summary.title, c.summary.agent, c.summary.model, c.agent_session_id.unwrap_or_default());
            for t in &c.turns {
                println!(
                    "--- {} {} seq={} status={:?} clar={}",
                    t.id,
                    t.role.as_str(),
                    t.seq,
                    t.status,
                    t.clarification_id.clone().unwrap_or_default()
                );
                println!("{}", t.text);
                if let Some(e) = &t.error {
                    println!("error: {}", e);
                }
            }
            for cl in &c.clarifications {
                println!("### clarification {} #{} anchor={} quote={:?} parent={}", cl.id, cl.number, cl.anchor_block_id, cl.quote, cl.parent_id.clone().unwrap_or_default());
            }
        }
    }
    Ok(())
}
