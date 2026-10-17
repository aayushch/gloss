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
    },
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
        Cmd::New { agent, model, no_web, project } => {
            let id = AgentId::parse(&agent).ok_or_else(|| anyhow!("unknown agent {}", agent))?;
            let conv = engine.create_conversation(id, model, Some(!no_web), project)?;
            println!("{}", conv.summary.id);
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
        Cmd::Send { conversation, text, quote, block, clarification, attach } => {
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
