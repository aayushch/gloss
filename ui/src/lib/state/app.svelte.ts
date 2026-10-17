// Application state as Svelte 5 runes. One instance (`app`) is shared by every
// component; it loads data through the API client and applies streamed turn
// events to the active conversation.

import { tick } from 'svelte';
import { api } from '$lib/api/client';
import type {
	AgentId,
	AgentInfo,
	Attachment,
	Clarification,
	Conversation,
	ConversationSummary,
	ModelInfo,
	SearchHit,
	Settings,
	Theme,
	Turn,
	TurnEventEnvelope
} from '$lib/api/types';
import { copyText } from '$lib/clipboard';
import { find } from '$lib/state/find.svelte';
import { artifactFileName, collectArtifacts, extractArtifacts, type Artifact, type ArtifactGroup, type ArtifactVersion } from '$lib/markdown/artifacts';
import { exportConversation, exportFileName, exportTurn } from '$lib/markdown/export';

/** Floating "Ask about this" button position and target. */
export interface PendingAsk {
	blockId: string;
	quote: string;
	x: number;
	y: number;
}

/** Inline composer target. `parentId` is the clarification whose reply holds the block. */
export interface ComposerFor {
	blockId: string;
	quote: string;
	parentId: string | null;
}

export interface Activity {
	kind: 'thinking' | 'tool' | 'status';
	label: string;
}

/** A conversation the user opened but has not sent anything in yet. */
export interface Draft {
	agent: AgentId;
	model: string;
	webSearch: boolean;
}

export const AGENT_NAMES: Record<AgentId, string> = {
	claude: 'Claude Code',
	codex: 'Codex CLI',
	gemini: 'Gemini CLI',
	pi: 'Pi',
	cursor: 'Cursor Agent'
};

class AppState {
	agents = $state<AgentInfo[]>([]);
	models = $state<Partial<Record<AgentId, ModelInfo[]>>>({});
	settings = $state<Settings>({ defaultAgent: 'claude', defaultModel: {}, theme: 'light', webSearch: true });
	conversations = $state<ConversationSummary[]>([]);
	active = $state<Conversation | null>(null);
	/** Set while a new chat has been opened but nothing sent yet. */
	draft = $state<Draft | null>(null);
	search = $state('');
	/** Full-text hits for `search`, or null when the search box is empty. */
	searchHits = $state<SearchHit[] | null>(null);
	/** Only conversations carrying this tag are listed. */
	tagFilter = $state<string | null>(null);
	/** Every tag in use, for the rail's filter chips. */
	tags = $state<string[]>([]);
	/** Files picked for the next main-column message, in order. */
	staged = $state<Attachment[]>([]);
	attachError = $state<string | null>(null);
	/** Object URLs for image attachments, by attachment id. */
	thumbs = $state<Record<string, string>>({});
	/** Short confirmation shown after an export, cleared after a moment. */
	notice = $state<string | null>(null);
	/** The artifact version open in the pane: an id and the turn that wrote it. */
	artifactView = $state<{ identifier: string; turnId: string } | null>(null);
	/** Every artifact of the active conversation, grouped by id with versions in order. */
	artifacts: ArtifactGroup[] = $derived(this.active ? collectArtifacts(this.active) : []);
	settingsOpen = $state(false);
	modelMenuOpen = $state(false);
	pendingAsk = $state<PendingAsk | null>(null);
	composerFor = $state<ComposerFor | null>(null);
	/** Activity line text per assistant turn id while it is running. */
	activity = $state<Record<string, Activity>>({});
	/** Element id of the well to scroll to after the next render. */
	jumpTarget = $state<string | null>(null);
	loadError = $state<string | null>(null);

	private unlisten: (() => void) | null = null;
	private noticeTimer: ReturnType<typeof setTimeout> | undefined;
	/** The last artifact the pane opened on its own while a reply streamed. */
	private autoOpened: string | null = null;

	get activeAgent(): AgentInfo | undefined {
		const id = this.active?.agent ?? this.draft?.agent ?? this.settings.defaultAgent;
		return this.agents.find((a) => a.id === id);
	}

	get activeAgentId(): AgentId {
		return this.active?.agent ?? this.draft?.agent ?? this.settings.defaultAgent;
	}

	get activeModelId(): string {
		if (this.active) return this.active.model;
		if (this.draft) return this.draft.model;
		return this.settings.defaultModel[this.settings.defaultAgent] ?? '';
	}

	get activeWebSearch(): boolean {
		return this.active?.webSearch ?? this.draft?.webSearch ?? this.settings.webSearch;
	}

	get running(): boolean {
		return !!this.active?.turns.some((t) => t.role === 'assistant' && (t.status === 'pending' || t.status === 'streaming'));
	}

	modelName(agent: AgentId, modelId: string): string {
		const list = this.models[agent] ?? [];
		const found = list.find((m) => m.id === modelId) ?? (modelId ? null : list.find((m) => m.isDefault));
		return found?.name ?? (modelId || 'Default model');
	}

	async init(): Promise<void> {
		const a = await api();
		try {
			const [agents, settings, conversations] = await Promise.all([a.listAgents(), a.getSettings(), a.listConversations()]);
			this.agents = agents;
			this.settings = settings;
			this.conversations = conversations;
			this.applyTheme(settings.theme, false);
			this.refreshTags();
			await Promise.all(agents.map((ag) => this.loadModels(ag.id)));
			if (conversations.length) await this.open(conversations[0].id);
			else this.newChat();
		} catch (e) {
			this.loadError = String(e);
		}
		this.unlisten?.();
		this.unlisten = await a.onTurnEvent((e) => this.applyEvent(e));
	}

	async loadModels(agent: AgentId): Promise<void> {
		try {
			const list = await (await api()).listModels(agent);
			this.models = { ...this.models, [agent]: list };
		} catch {
			this.models = { ...this.models, [agent]: [] };
		}
	}

	async refreshList(): Promise<void> {
		const a = await api();
		const q = this.search.trim();
		const [list, hits] = await Promise.all([a.listConversations(q || undefined, this.tagFilter ?? undefined), q ? a.search(q) : Promise.resolve(null)]);
		// A stale response must not overwrite the result of a newer query.
		if (q !== this.search.trim()) return;
		this.conversations = list;
		this.searchHits = hits;
	}

	async refreshTags(): Promise<void> {
		try {
			this.tags = await (await api()).listTags();
		} catch {
			this.tags = [];
		}
		if (this.tagFilter && !this.tags.includes(this.tagFilter)) {
			this.tagFilter = null;
			this.refreshList();
		}
	}

	setTagFilter(tag: string | null): void {
		this.tagFilter = this.tagFilter === tag ? null : tag;
		this.refreshList();
	}

	/** Opens the conversation a search hit belongs to and lands on the matched
	 * words: the find bar opens with the search text and its current match is
	 * the first one inside the hit's turn. When the words are not found as a
	 * phrase, the first search word is tried; when nothing matches at all,
	 * the transcript scrolls to the turn instead. */
	async openHit(hit: SearchHit): Promise<void> {
		if (this.active?.id !== hit.conversationId) await this.open(hit.conversationId);
		if (!hit.turnId) return;
		if (hit.clarificationId) this.openClarificationChain(hit.clarificationId);
		await tick();
		await new Promise(requestAnimationFrame);
		const turnEl = document.getElementById(`turn-${hit.turnId}`);
		const phrase = this.search.trim();
		const word = phrase.split(/\s+/)[0] ?? '';
		for (const q of [phrase, word]) {
			if (q && find.show(q, turnEl)) return;
		}
		find.hide();
		this.jumpTarget = `turn-${hit.turnId}`;
	}

	async togglePin(id = this.active?.id): Promise<void> {
		const cur = this.conversations.find((c) => c.id === id) ?? this.active;
		if (!id || !cur) return;
		const s = await (await api()).setPinned(id, !cur.pinned);
		this.patchSummary(s);
		if (this.active?.id === id) this.active.pinned = s.pinned;
		this.conversations = [...this.conversations].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
	}

	async setTags(tags: string[], id = this.active?.id): Promise<void> {
		if (!id) return;
		const s = await (await api()).setTags(id, tags);
		this.patchSummary(s);
		if (this.active?.id === id) this.active.tags = s.tags;
		await this.refreshTags();
	}

	// ── attachments ─────────────────────────────────────────────────────

	/** Stages files for the next message. Files the engine rejects are reported, not staged. */
	async attach(files: Iterable<File>): Promise<void> {
		const a = await api();
		this.attachError = null;
		for (const f of files) {
			try {
				const bytes = new Uint8Array(await f.arrayBuffer());
				const att = await a.addAttachment(f.name || 'pasted', f.type, bytes);
				this.staged = [...this.staged, att];
				this.loadThumb(att);
			} catch (e) {
				this.attachError = String(e).replace(/^Error:\s*/, '');
			}
		}
	}

	async unstage(id: string): Promise<void> {
		this.staged = this.staged.filter((s) => s.id !== id);
		(await api()).removeAttachment(id).catch(() => {});
	}

	/** Loads an image attachment's preview URL once. */
	async loadThumb(att: Attachment): Promise<void> {
		if (att.kind !== 'image' || this.thumbs[att.id]) return;
		try {
			const url = await (await api()).attachmentUrl(att);
			if (url) this.thumbs = { ...this.thumbs, [att.id]: url };
		} catch {
			// A missing preview leaves the chip without an image.
		}
	}

	// ── export ──────────────────────────────────────────────────────────

	async copyTurnMarkdown(turn: Turn): Promise<void> {
		if (!this.active) return;
		if (await copyText(exportTurn(this.active, turn))) this.flash('Copied as Markdown');
	}

	async saveTurnMarkdown(turn: Turn): Promise<void> {
		if (!this.active) return;
		const path = await (await api()).saveTextFile(exportFileName(this.active.title, '-reply'), exportTurn(this.active, turn));
		if (path) this.flash(`Saved ${path}`);
	}

	async copyConversationMarkdown(): Promise<void> {
		if (!this.active) return;
		if (await copyText(exportConversation(this.active))) this.flash('Copied conversation as Markdown');
	}

	async saveConversationMarkdown(): Promise<void> {
		if (!this.active) return;
		const path = await (await api()).saveTextFile(exportFileName(this.active.title), exportConversation(this.active));
		if (path) this.flash(`Saved ${path}`);
	}

	// ── artifacts ───────────────────────────────────────────────────────

	/** The artifact group the pane shows, if any. */
	get viewedGroup(): ArtifactGroup | undefined {
		const v = this.artifactView;
		return v ? this.artifacts.find((g) => g.identifier === v.identifier) : undefined;
	}

	/** The artifact version open in the pane. Falls back to the latest
	 * version when the viewed turn no longer holds one. */
	get viewedArtifact(): ArtifactVersion | undefined {
		const v = this.artifactView;
		const g = this.viewedGroup;
		if (!v || !g) return undefined;
		return g.versions.find((x) => x.turnId === v.turnId) ?? g.versions[g.versions.length - 1];
	}

	openArtifact(identifier: string, turnId: string): void {
		this.artifactView = { identifier, turnId };
	}

	closeArtifact(): void {
		this.artifactView = null;
	}

	/** Shows version `n` (1-based) of the artifact in the pane. */
	showArtifactVersion(n: number): void {
		const g = this.viewedGroup;
		const v = g?.versions[n - 1];
		if (g && v) this.artifactView = { identifier: g.identifier, turnId: v.turnId };
	}

	isViewing(identifier: string, turnId: string): boolean {
		const a = this.viewedArtifact;
		return !!a && a.identifier === identifier && a.turnId === turnId;
	}

	async copyArtifact(a: Artifact): Promise<void> {
		if (await copyText(a.content)) this.flash(`Copied ${a.title}`);
	}

	async saveArtifact(a: Artifact): Promise<void> {
		const path = await (await api()).saveTextFile(artifactFileName(a), a.content);
		if (path) this.flash(`Saved ${path}`);
	}

	/** Opens the artifact with the system's default app, the browser for HTML. */
	async openArtifactExternally(a: Artifact): Promise<void> {
		try {
			await (await api()).openArtifact(artifactFileName(a), a.content);
		} catch (e) {
			this.flash(`Could not open: ${String(e).replace(/^Error:\s*/, '')}`);
		}
	}

	/** Opens the pane on the newest artifact of a streaming turn, once per artifact. */
	private autoOpenArtifact(turn: Turn): void {
		if (!turn.text.includes('<artifact') && !turn.text.includes('```')) return;
		const found = extractArtifacts(turn.text).artifacts;
		const last = found[found.length - 1];
		if (!last) return;
		const key = `${turn.id}/${last.identifier}`;
		if (this.autoOpened === key) return;
		this.autoOpened = key;
		this.artifactView = { identifier: last.identifier, turnId: turn.id };
	}

	private flash(text: string): void {
		this.notice = text;
		clearTimeout(this.noticeTimer);
		this.noticeTimer = setTimeout(() => (this.notice = null), 2500);
	}

	async open(id: string): Promise<void> {
		this.draft = null;
		this.pendingAsk = null;
		this.composerFor = null;
		this.modelMenuOpen = false;
		this.artifactView = null;
		this.active = await (await api()).getConversation(id);
		for (const t of this.active.turns) t.attachments.forEach((att) => this.loadThumb(att));
	}

	newChat(): void {
		const agent = this.agents.find((a) => a.id === this.settings.defaultAgent && a.available)?.id ?? this.agents.find((a) => a.available)?.id ?? this.settings.defaultAgent;
		this.active = null;
		this.pendingAsk = null;
		this.composerFor = null;
		this.modelMenuOpen = false;
		this.artifactView = null;
		this.draft = { agent, model: this.settings.defaultModel[agent] ?? '', webSearch: this.settings.webSearch };
	}

	async setModel(model: string): Promise<void> {
		this.modelMenuOpen = false;
		if (this.draft) {
			this.draft.model = model;
			return;
		}
		if (!this.active) return;
		const s = await (await api()).setConversationModel(this.active.id, model);
		this.active.model = s.model;
		this.patchSummary(s);
	}

	async setWebSearch(enabled: boolean): Promise<void> {
		if (this.draft) {
			this.draft.webSearch = enabled;
			return;
		}
		if (!this.active) return;
		const s = await (await api()).setConversationWebSearch(this.active.id, enabled);
		this.active.webSearch = s.webSearch;
		this.patchSummary(s);
	}

	async setDraftAgent(agent: AgentId): Promise<void> {
		if (!this.draft) return;
		this.draft.agent = agent;
		this.draft.model = this.settings.defaultModel[agent] ?? '';
	}

	async saveSettings(patch: Partial<Settings>): Promise<void> {
		const next = { ...this.settings, ...patch, defaultModel: { ...this.settings.defaultModel, ...(patch.defaultModel ?? {}) } };
		this.settings = await (await api()).updateSettings(next);
		if (this.draft && patch.defaultAgent) {
			this.draft.agent = this.settings.defaultAgent;
			this.draft.model = this.settings.defaultModel[this.settings.defaultAgent] ?? '';
		}
	}

	async applyTheme(theme: Theme, persist = true): Promise<void> {
		if (typeof document !== 'undefined') document.documentElement.dataset.mode = theme;
		const a = await api();
		a.setTheme(theme).catch(() => {});
		if (persist) {
			this.settings = { ...this.settings, theme };
			await a.updateSettings(this.settings);
		}
	}

	toggleTheme(): void {
		this.applyTheme(this.settings.theme === 'dark' ? 'light' : 'dark');
	}

	async rename(id: string, title: string): Promise<void> {
		const s = await (await api()).renameConversation(id, title);
		this.patchSummary(s);
		if (this.active?.id === id) this.active.title = s.title;
	}

	async remove(id: string): Promise<void> {
		await (await api()).deleteConversation(id);
		this.conversations = this.conversations.filter((c) => c.id !== id);
		if (this.active?.id === id) {
			if (this.conversations.length) await this.open(this.conversations[0].id);
			else this.newChat();
		}
	}

	/** Sends a main-column message, creating the conversation for a draft. */
	async send(text: string): Promise<void> {
		const body = text.trim();
		if (!body) return;
		const a = await api();
		if (this.draft) {
			const d = this.draft;
			const conv = await a.createConversation(d.agent, d.model || undefined, d.webSearch);
			this.draft = null;
			this.active = conv;
			this.conversations = [summaryOf(conv), ...this.conversations];
		}
		if (!this.active) return;
		const ids = this.staged.map((s) => s.id);
		this.staged = [];
		await this.dispatch(body, null, ids);
	}

	/** Opens a new clarification on the composer's target. */
	async ask(question: string): Promise<void> {
		const target = this.composerFor;
		const body = question.trim();
		if (!target || !body || !this.active) return;
		this.composerFor = null;
		await this.dispatch(body, { kind: 'new', anchorBlockId: target.blockId, quote: target.quote, parentId: target.parentId });
	}

	async followUp(clarificationId: string, question: string): Promise<void> {
		const body = question.trim();
		if (!body || !this.active) return;
		await this.dispatch(body, { kind: 'existing', clarificationId });
	}

	private async dispatch(text: string, clarification: Parameters<typeof this.sendRaw>[1], attachments: string[] = []): Promise<void> {
		await this.sendRaw(text, clarification, attachments);
	}

	private async sendRaw(
		text: string,
		clarification: { kind: 'new'; anchorBlockId: string; quote: string; parentId: string | null } | { kind: 'existing'; clarificationId: string } | null,
		attachments: string[] = []
	): Promise<void> {
		if (!this.active) return;
		const conv = this.active;
		const res = await (await api()).sendTurn({ conversationId: conv.id, text, clarification, attachments });
		if (this.active?.id !== conv.id) return;
		this.active.turns = [...this.active.turns, res.userTurn, res.assistantTurn];
		if (res.clarification) {
			this.active.clarifications = [...this.active.clarifications, res.clarification];
			this.active.clarificationCount = this.active.clarifications.length;
		}
		if (this.active.turns.length === 2) {
			// The engine derives the title from the first message; mirror it until the list refreshes.
			this.active.title = text.length > 60 ? text.slice(0, 57).trimEnd() + '…' : text;
		}
		this.active.running = true;
		this.patchSummary(summaryOf(this.active));
	}

	/** Re-sends the text of a failed user turn. */
	async retry(userTurn: Turn): Promise<void> {
		if (!this.active) return;
		const clarification = userTurn.clarificationId ? ({ kind: 'existing', clarificationId: userTurn.clarificationId } as const) : null;
		await this.sendRaw(userTurn.text, clarification);
	}

	async cancel(): Promise<void> {
		if (!this.active) return;
		await (await api()).cancelTurn(this.active.id);
	}

	async toggleClarification(id: string, open?: boolean): Promise<void> {
		if (!this.active) return;
		const cl = this.active.clarifications.find((c) => c.id === id);
		if (!cl) return;
		cl.open = open ?? !cl.open;
		(await api()).setClarificationOpen(id, cl.open).catch(() => {});
	}

	/** Opens a clarification (and its parent chain) and scrolls to it. */
	jumpTo(id: string): void {
		if (!this.active) return;
		this.openClarificationChain(id);
		this.jumpTarget = `well-${id}`;
	}

	/** Expands a clarification and every well it is nested in. */
	private openClarificationChain(id: string): void {
		if (!this.active) return;
		let cur: Clarification | undefined = this.active.clarifications.find((c) => c.id === id);
		while (cur) {
			if (!cur.open) this.toggleClarification(cur.id, true);
			const parentId: string | null = cur.parentId;
			cur = parentId ? this.active.clarifications.find((c) => c.id === parentId) : undefined;
		}
	}

	private applyEvent(e: TurnEventEnvelope): void {
		const conv = this.active;
		if (!conv || conv.id !== e.conversationId) {
			if (e.event.type === 'done' || e.event.type === 'failed' || e.event.type === 'cancelled') this.refreshList();
			return;
		}
		const idx = conv.turns.findIndex((t) => t.id === e.turnId);
		if (idx < 0) return;
		const turn = conv.turns[idx];
		switch (e.event.type) {
			case 'started':
				turn.status = 'streaming';
				if (e.event.model) turn.model = e.event.model;
				if (e.event.sessionId) conv.agentSessionId = e.event.sessionId;
				break;
			case 'delta':
				turn.status = 'streaming';
				turn.text += e.event.text;
				delete this.activity[turn.id];
				this.autoOpenArtifact(turn);
				break;
			case 'replace':
				turn.text = e.event.text;
				this.autoOpenArtifact(turn);
				break;
			case 'activity':
				this.activity[turn.id] = { kind: e.event.kind, label: e.event.label };
				break;
			case 'done':
			case 'failed':
			case 'cancelled':
				conv.turns[idx] = e.event.turn;
				conv.running = false;
				delete this.activity[turn.id];
				this.autoOpenArtifact(e.event.turn);
				this.refreshList();
				break;
		}
	}

	private patchSummary(s: ConversationSummary): void {
		const i = this.conversations.findIndex((c) => c.id === s.id);
		if (i >= 0) this.conversations[i] = { ...this.conversations[i], ...s };
		else this.conversations = [s, ...this.conversations];
	}
}

function summaryOf(c: Conversation): ConversationSummary {
	return {
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
	};
}

/** "1.2 MB", "340 KB" or "12 B". */
export function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

export const app = new AppState();
