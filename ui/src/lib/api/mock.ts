// In-memory stand-in for the engine, used when the app runs in a plain
// browser. Replies stream a canned answer in small pieces so the pending
// state, deltas and completion path are all exercised.

import type { Api } from './client';
import type {
	AgentId,
	AgentInfo,
	Attachment,
	Clarification,
	Conversation,
	ConversationSummary,
	ModelInfo,
	Settings,
	Turn,
	TurnEventEnvelope
} from './types';

const AGENTS: AgentInfo[] = [
	{ id: 'claude', name: 'Claude Code', command: 'claude', monogram: 'cc', available: true, path: '/usr/local/bin/claude', version: '2.1.296', supportsModelSelect: true, supportsWebSearch: true },
	{ id: 'codex', name: 'Codex CLI', command: 'codex', monogram: 'cx', available: true, path: '/usr/local/bin/codex', version: '0.118.0', supportsModelSelect: true, supportsWebSearch: true },
	{ id: 'gemini', name: 'Gemini CLI', command: 'gemini', monogram: 'gm', available: false, path: null, version: null, supportsModelSelect: true, supportsWebSearch: true },
	{ id: 'pi', name: 'Pi', command: 'pi', monogram: 'pi', available: true, path: '/opt/homebrew/bin/pi', version: '0.79.6', supportsModelSelect: true, supportsWebSearch: false },
	{ id: 'cursor', name: 'Cursor Agent', command: 'cursor-agent', monogram: 'cu', available: false, path: null, version: null, supportsModelSelect: false, supportsWebSearch: true }
];

const MODELS: Record<AgentId, ModelInfo[]> = {
	claude: [
		{ id: 'opus', name: 'Claude Opus', note: 'Most capable · slower', context: '200k', isDefault: false },
		{ id: 'sonnet', name: 'Claude Sonnet', note: 'Balanced · default', context: '200k', isDefault: true },
		{ id: 'haiku', name: 'Claude Haiku', note: 'Fastest · cheapest', context: '200k', isDefault: false }
	],
	codex: [
		{ id: 'gpt-5-codex', name: 'GPT-5 Codex', note: 'Tuned for code · default', context: '400k', isDefault: true },
		{ id: 'gpt-5', name: 'GPT-5', note: 'General', context: '400k', isDefault: false }
	],
	gemini: [
		{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', note: 'Most capable · default', context: '1M', isDefault: true },
		{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', note: 'Fast', context: '1M', isDefault: false }
	],
	pi: [{ id: 'lmstudio/qwen/qwen3.6-35b-a3b', name: 'qwen/qwen3.6-35b-a3b', note: 'lmstudio', context: '128K', isDefault: true }],
	cursor: [{ id: 'auto', name: 'Auto', note: 'Chosen by Cursor', context: null, isDefault: true }]
};

const CAS_QUESTION = 'How do CPUs actually implement atomic compare-and-swap, and how do locks build on it?';
const CAS_ANSWER = `The simplest way to say what CAS does: “compare the value at this address with what I expect; if they match, write the new value; and tell me whether it worked.” In C-like pseudocode:

\`\`\`c
// Atomic only if the hardware makes it so
bool CAS(int *addr, int expected, int new) {
    if (*addr == expected) { *addr = new; return true; }
    return false;
}
\`\`\`

Written like that in software it is useless for synchronization. It is a read followed by a write, and another core can write to \`addr\` between the two. The hardware has to guarantee that the read-compare-write happens as one indivisible step that no other agent in the system can observe partway through.

#### Why software alone can’t do it

On a single-core machine you can get atomicity by disabling interrupts around the read and write. With multiple cores that doesn’t help: other cores keep executing and touching the same memory in parallel, and so do DMA devices. You need something that arbitrates access to memory itself, and only the hardware sits in that position.

#### Approach 1: Lock the memory location (x86 \`LOCK CMPXCHG\`)

On x86, CAS is the \`CMPXCHG\` instruction with a \`LOCK\` prefix. Implementations have changed over time:

- **Bus locking (old processors).** The CPU asserted a physical \`LOCK#\` signal on the shared front-side bus. While it was held, no other processor could access memory, so the read and write were trivially atomic.
- **Cache locking (modern processors).** Atomicity now comes from the cache coherence protocol (MESI and its variants):
  1. The core requests the cache line containing \`addr\` in an **exclusive/modified** state, which invalidates every other core’s copy.
  2. It then **locks that line in its own cache** for the duration of the instruction. If another core sends a coherence request for the line (a snoop), the response is delayed until the CAS finishes.

A locked instruction on x86 also acts as a full memory barrier. Earlier loads and stores can’t be reordered past it, which is part of why it works as a lock-acquire primitive.

- On ARM and RISC-V you choose explicitly: acquire variants (\`LDAXR\`, \`CASA\`), release variants (\`STLXR\`, \`CASL\`), or both. Lock acquire uses acquire semantics so later accesses can’t move above it. Unlock uses release semantics so earlier accesses can’t move below it.

#### From CAS to mutexes and semaphores

With that hardware guarantee in place, the rest is software:

- **Spinlock:** \`while (!CAS(&lock, 0, 1)) { pause; }\`, and unlock is a release-store of 0.
- **Mutex (e.g., Linux futex):** the uncontended fast path is a single CAS in user space with no syscall. If the CAS fails, the thread asks the kernel to put it to sleep on that address, and the unlocker wakes it.
- **Semaphore:** a CAS loop on a counter (or an atomic decrement), plus the same sleep/wake mechanism when the count reaches zero.

The hardware’s role is to make one memory location’s read-compare-write indivisible and properly ordered. It does this either by holding exclusive ownership of the cache line for the whole operation (x86) or by detecting any interference and failing the store (LL/SC). Every higher-level synchronization primitive is built on that one guarantee.`;

const RUST_QUESTION = 'When should I take ownership of a value versus borrowing it?';
const RUST_ANSWER = `Default to borrowing. Take \`&T\` when you only read, \`&mut T\` when you mutate in place, and take ownership (\`T\`) only when the function needs to **keep** the value — store it, move it into a thread, or return it transformed.

\`\`\`rust
fn summarize(items: &[Order]) -> Summary { /* read-only */ }
fn archive(order: Order) { store.push(order); } // keeps it
\`\`\`

The borrow checker is really a *lifetime* checker: a borrow must not outlive the owner. If a signature forces you into clones, that is usually a sign the data should be owned one level up.`;

const CANNED_REPLY = `Both, for different reasons. The compiler reorders at build time when it can prove a single thread won’t notice; the CPU reorders at run time through its store buffer and out-of-order pipeline.

\`\`\`c
// Compiler may legally emit these in either order
data = 42;
ready = 1;   // another thread may see ready == 1 before data == 42
\`\`\`

A locked instruction constrains both: the compiler treats it as a barrier and the core drains the store buffer before retiring it.`;

let counter = 100;
const nextId = (p: string) => `${p}_${(counter++).toString(36)}`;
const now = () => Date.now();
const DAY = 86_400_000;

interface Conv extends ConversationSummary {
	agentSessionId: string | null;
	running: boolean;
	turns: Turn[];
	clarifications: Clarification[];
}

function makeTurn(conv: Conv, role: Turn['role'], text: string, extra: Partial<Turn> = {}): Turn {
	const t: Turn = {
		id: nextId('turn'),
		conversationId: conv.id,
		seq: conv.turns.length + 1,
		role,
		text,
		promptText: null,
		status: 'done',
		clarificationId: null,
		model: role === 'assistant' ? conv.model || 'sonnet' : null,
		error: null,
		usage: role === 'assistant' ? { inputTokens: 1200, outputTokens: 480, costUsd: 0.0041, durationMs: 3200 } : null,
		createdAt: now(),
		completedAt: now(),
		attachments: [],
		...extra
	};
	conv.turns.push(t);
	return t;
}

const COUNTER_PAGE = (color: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Click Counter</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f4f4f5; }
    button { font-size: 1.1rem; padding: 0.75rem 1.5rem; border: 0; border-radius: 8px; background: ${color}; color: white; cursor: pointer; }
  </style>
</head>
<body>
  <div><button id="btn">Click me</button><p>Clicks: <span id="count">0</span></p></div>
  <script>
    let clicks = 0;
    document.getElementById('btn').addEventListener('click', () => { clicks += 1; document.getElementById('count').textContent = clicks; });
  </script>
</body>
</html>`;
const ARTIFACT_V1 = `<artifact id="click-counter" type="text/html" title="Click Counter">\n${COUNTER_PAGE('#2563eb')}\n</artifact>`;
const ARTIFACT_V2 = `<artifact id="click-counter" type="text/html" title="Click Counter">\n${COUNTER_PAGE('#16a34a')}\n</artifact>`;

function seed(): Conv[] {
	const cas: Conv = {
		id: 'conv_cas',
		title: 'How CPUs implement CAS',
		agent: 'claude',
		model: 'sonnet',
		webSearch: true,
		pinned: true,
		tags: ['cpu', 'concurrency'],
		clarificationCount: 0,
		createdAt: now() - 3600_000,
		updatedAt: now() - 1800_000,
		agentSessionId: '32bead75-3df0-42d1-a069-faae5a2370fe',
		running: false,
		turns: [],
		clarifications: []
	};
	makeTurn(cas, 'user', CAS_QUESTION);
	const reply = makeTurn(cas, 'assistant', CAS_ANSWER);
	// One seeded clarification anchored to the x86 barrier paragraph (block 10).
	const cl: Clarification = {
		id: 'cl_seed1',
		conversationId: cas.id,
		number: 1,
		anchorBlockId: `${reply.id}:10`,
		quote: 'Earlier loads and stores can’t be reordered past it',
		parentId: null,
		open: true,
		createdAt: now() - 1000_000
	};
	cas.clarifications.push(cl);
	cas.clarificationCount = 1;
	makeTurn(cas, 'user', 'Who is actually doing this reordering — the compiler or the CPU?', { clarificationId: cl.id, promptText: `> "${cl.quote}"\n\nWho is actually doing this reordering — the compiler or the CPU?` });
	makeTurn(cas, 'assistant', CANNED_REPLY, { clarificationId: cl.id });

	const rust: Conv = {
		id: 'conv_rust',
		title: 'Rust ownership vs borrowing',
		agent: 'pi',
		model: '',
		webSearch: false,
		pinned: false,
		tags: ['rust'],
		clarificationCount: 0,
		createdAt: now() - DAY - 3600_000,
		updatedAt: now() - DAY,
		agentSessionId: null,
		running: false,
		turns: [],
		clarifications: []
	};
	makeTurn(rust, 'user', RUST_QUESTION);
	makeTurn(rust, 'assistant', RUST_ANSWER);

	const page: Conv = {
		id: 'conv_page',
		title: 'A click counter page',
		agent: 'claude',
		model: 'haiku',
		webSearch: false,
		pinned: false,
		tags: [],
		clarificationCount: 0,
		createdAt: now() - 2 * DAY,
		updatedAt: now() - 2 * DAY + 60_000,
		agentSessionId: null,
		running: false,
		turns: [],
		clarifications: []
	};
	makeTurn(page, 'user', 'Make me a small single-file HTML page with a button that counts clicks.');
	makeTurn(page, 'assistant', `Here is the page.\n\n${ARTIFACT_V1}\n\nClick the button to count.`);
	makeTurn(page, 'user', 'Make the button green.');
	makeTurn(page, 'assistant', `Done, the button is green now.\n\n${ARTIFACT_V2}`);
	return [cas, rust, page];
}

export function mockApi(): Api {
	const convs = seed();
	let settings: Settings = { defaultAgent: 'claude', defaultModel: { claude: 'sonnet' }, theme: 'light', webSearch: true };
	const listeners = new Set<(e: TurnEventEnvelope) => void>();
	const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

	const summary = (c: Conv): ConversationSummary => ({
		id: c.id,
		title: c.title,
		agent: c.agent,
		model: c.model,
		webSearch: c.webSearch,
		pinned: c.pinned,
		tags: c.tags,
		clarificationCount: c.clarifications.length,
		createdAt: c.createdAt,
		updatedAt: c.updatedAt
	});
	const staged = new Map<string, { att: Attachment; url: string }>();
	const full = (c: Conv): Conversation => ({ ...summary(c), agentSessionId: c.agentSessionId, running: c.running, turns: c.turns.map((t) => ({ ...t })), clarifications: c.clarifications.map((x) => ({ ...x })) });
	const find = (id: string): Conv => {
		const c = convs.find((x) => x.id === id);
		if (!c) throw new Error(`No conversation ${id}`);
		return c;
	};
	const emit = (e: TurnEventEnvelope) => listeners.forEach((l) => l(e));

	function stream(conv: Conv, turn: Turn, text: string) {
		conv.running = true;
		turn.status = 'streaming';
		const pieces = text.match(/[^\n]{1,12}|\n+/g) ?? [text];
		const total = 1200;
		const list: ReturnType<typeof setTimeout>[] = [];
		list.push(setTimeout(() => emit({ conversationId: conv.id, turnId: turn.id, event: { type: 'started', sessionId: conv.agentSessionId, model: conv.model || 'sonnet' } }), 80));
		list.push(setTimeout(() => emit({ conversationId: conv.id, turnId: turn.id, event: { type: 'activity', kind: 'thinking', label: 'Thinking…' } }), 120));
		pieces.forEach((p, i) => {
			list.push(
				setTimeout(() => {
					turn.text += p;
					emit({ conversationId: conv.id, turnId: turn.id, event: { type: 'delta', text: p } });
				}, 300 + (total * i) / pieces.length)
			);
		});
		list.push(
			setTimeout(() => {
				turn.status = 'done';
				turn.completedAt = now();
				turn.usage = { inputTokens: 1800, outputTokens: 220, costUsd: 0.0027, durationMs: total };
				conv.running = false;
				conv.updatedAt = now();
				timers.delete(conv.id);
				emit({ conversationId: conv.id, turnId: turn.id, event: { type: 'done', turn: { ...turn } } });
			}, 300 + total + 50)
		);
		timers.set(conv.id, list);
	}

	return {
		listAgents: async () => AGENTS,
		listModels: async (agent) => MODELS[agent],
		getSettings: async () => settings,
		updateSettings: async (s) => (settings = s),
		listConversations: async (query, tag) => {
			const q = (query ?? '').trim().toLowerCase();
			return convs
				.filter((c) => !q || c.title.toLowerCase().includes(q) || c.turns.some((t) => t.text.toLowerCase().includes(q)))
				.filter((c) => !tag || c.tags.includes(tag))
				.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
				.map(summary);
		},
		search: async (query) => {
			const q = query.trim().toLowerCase();
			if (!q) return [];
			const hits = [];
			for (const c of convs) {
				if (c.title.toLowerCase().includes(q)) hits.push({ conversationId: c.id, title: c.title, agent: c.agent, turnId: null, role: null, clarificationId: null, snippet: '', updatedAt: c.updatedAt });
				for (const t of c.turns) {
					const i = t.text.toLowerCase().indexOf(q);
					if (i < 0) continue;
					const start = Math.max(0, i - 40);
					const snippet = (start > 0 ? '…' : '') + t.text.slice(start, i) + '\u0001' + t.text.slice(i, i + q.length) + '\u0002' + t.text.slice(i + q.length, i + q.length + 60) + '…';
					hits.push({ conversationId: c.id, title: c.title, agent: c.agent, turnId: t.id, role: t.role, clarificationId: t.clarificationId, snippet: snippet.replace(/\n/g, ' '), updatedAt: c.updatedAt });
				}
			}
			return hits;
		},
		setPinned: async (id, pinned) => {
			const c = find(id);
			c.pinned = pinned;
			return summary(c);
		},
		setTags: async (id, tags) => {
			const c = find(id);
			c.tags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
			return summary(c);
		},
		listTags: async () => [...new Set(convs.flatMap((c) => c.tags))],
		addAttachment: async (name, mime, bytes) => {
			const isImage = /^image\/(png|jpeg|gif|webp)$/.test(mime) || /\.(png|jpe?g|gif|webp)$/i.test(name);
			const att: Attachment = { id: nextId('att'), name, mime: mime || 'text/plain', kind: isImage ? 'image' : 'text', size: bytes.length, path: `/mock/${name}`, turnId: null, createdAt: now() };
			staged.set(att.id, { att, url: URL.createObjectURL(new Blob([bytes.slice()], { type: att.mime })) });
			return att;
		},
		removeAttachment: async (id) => {
			staged.delete(id);
		},
		attachmentUrl: async (att) => staged.get(att.id)?.url ?? '',
		saveTextFile: async (defaultName, contents) => {
			const a = document.createElement('a');
			a.href = URL.createObjectURL(new Blob([contents], { type: 'text/markdown' }));
			a.download = defaultName;
			a.click();
			return defaultName;
		},
		openArtifact: async (name, contents) => {
			const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/plain';
			window.open(URL.createObjectURL(new Blob([contents], { type })), '_blank');
			return name;
		},
		getConversation: async (id) => full(find(id)),
		createConversation: async (agent, model, webSearch) => {
			const c: Conv = {
				id: nextId('conv'),
				title: 'New conversation',
				agent,
				model: model ?? '',
				webSearch: webSearch ?? settings.webSearch,
				pinned: false,
				tags: [],
				clarificationCount: 0,
				createdAt: now(),
				updatedAt: now(),
				agentSessionId: null,
				running: false,
				turns: [],
				clarifications: []
			};
			convs.unshift(c);
			return full(c);
		},
		renameConversation: async (id, title) => {
			const c = find(id);
			c.title = title;
			return summary(c);
		},
		deleteConversation: async (id) => {
			const i = convs.findIndex((c) => c.id === id);
			if (i >= 0) convs.splice(i, 1);
		},
		setConversationModel: async (id, model) => {
			const c = find(id);
			c.model = model;
			return summary(c);
		},
		setConversationWebSearch: async (id, enabled) => {
			const c = find(id);
			c.webSearch = enabled;
			return summary(c);
		},
		sendTurn: async (req) => {
			const c = find(req.conversationId);
			if (c.running) throw new Error('A turn is already running in this conversation');
			let clarification: Clarification | null = null;
			let clarificationId: string | null = null;
			let promptText: string | null = null;
			if (req.clarification?.kind === 'new') {
				clarification = {
					id: nextId('cl'),
					conversationId: c.id,
					number: c.clarifications.length + 1,
					anchorBlockId: req.clarification.anchorBlockId,
					quote: req.clarification.quote,
					parentId: req.clarification.parentId,
					open: true,
					createdAt: now()
				};
				c.clarifications.push(clarification);
				clarificationId = clarification.id;
				promptText = `The user highlighted this excerpt of your previous answer and is asking about it.\n\n> "${clarification.quote}"\n\n${req.text}`;
			} else if (req.clarification?.kind === 'existing') {
				clarificationId = req.clarification.clarificationId;
				const cl = c.clarifications.find((x) => x.id === clarificationId);
				promptText = `Follow-up about the excerpt "${cl?.quote.slice(0, 44) ?? ''}":\n\n${req.text}`;
			}
			if (c.turns.length === 0) c.title = req.text.length > 60 ? req.text.slice(0, 57).trimEnd() + '…' : req.text;
			const attachments = (req.attachments ?? []).map((id) => staged.get(id)?.att).filter((a): a is Attachment => !!a);
			const userTurn = makeTurn(c, 'user', req.text, { clarificationId, promptText, attachments });
			attachments.forEach((a) => (a.turnId = userTurn.id));
			const assistantTurn = makeTurn(c, 'assistant', '', { clarificationId, status: 'pending', usage: null, completedAt: null });
			c.updatedAt = now();
			c.agentSessionId ??= nextId('sess');
			const reply = clarificationId ? CANNED_REPLY : req.text.toLowerCase().includes('rust') ? RUST_ANSWER : CAS_ANSWER;
			stream(c, assistantTurn, reply);
			return { userTurn: { ...userTurn }, assistantTurn: { ...assistantTurn }, clarification };
		},
		cancelTurn: async (conversationId) => {
			const c = find(conversationId);
			const list = timers.get(c.id) ?? [];
			list.forEach(clearTimeout);
			timers.delete(c.id);
			const turn = c.turns.find((t) => t.role === 'assistant' && !['done', 'error', 'cancelled'].includes(t.status));
			c.running = false;
			if (turn) {
				turn.status = 'cancelled';
				turn.completedAt = now();
				emit({ conversationId: c.id, turnId: turn.id, event: { type: 'cancelled', turn: { ...turn } } });
			}
		},
		startDrag: async () => {},
		setClarificationOpen: async (id, open) => {
			for (const c of convs) {
				const cl = c.clarifications.find((x) => x.id === id);
				if (cl) cl.open = open;
			}
		},
		setTheme: async (theme) => {
			settings = { ...settings, theme };
		},
		onTurnEvent: async (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		}
	};
}
