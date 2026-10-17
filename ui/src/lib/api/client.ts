// Typed wrappers around the Tauri commands listed in docs/api.md. Outside
// Tauri (plain `vite dev` in a browser) the in-memory mock takes over so the
// UI can be exercised without an engine.

import type {
	AgentId,
	AgentInfo,
	Attachment,
	Conversation,
	ConversationSummary,
	ModelInfo,
	SearchHit,
	SendTurnRequest,
	SendTurnResult,
	Settings,
	Theme,
	TurnEventEnvelope
} from './types';

export interface Api {
	listAgents(): Promise<AgentInfo[]>;
	listModels(agent: AgentId): Promise<ModelInfo[]>;
	getSettings(): Promise<Settings>;
	updateSettings(settings: Settings): Promise<Settings>;
	listConversations(query?: string, tag?: string): Promise<ConversationSummary[]>;
	search(query: string): Promise<SearchHit[]>;
	setPinned(id: string, pinned: boolean): Promise<ConversationSummary>;
	setTags(id: string, tags: string[]): Promise<ConversationSummary>;
	listTags(): Promise<string[]>;
	/** Stores a file for a later turn and returns its record. */
	addAttachment(name: string, mime: string, bytes: Uint8Array): Promise<Attachment>;
	removeAttachment(id: string): Promise<void>;
	/** A URL the webview can show the attachment from (object URL). */
	attachmentUrl(att: Attachment): Promise<string>;
	/** Native save dialog; resolves to the written path or null if dismissed. */
	saveTextFile(defaultName: string, contents: string): Promise<string | null>;
	/** Writes an artifact to the artifacts folder and opens it with the system's default app. */
	openArtifact(name: string, contents: string): Promise<string>;
	getConversation(id: string): Promise<Conversation>;
	createConversation(agent: AgentId, model?: string, webSearch?: boolean): Promise<Conversation>;
	renameConversation(id: string, title: string): Promise<ConversationSummary>;
	deleteConversation(id: string): Promise<void>;
	setConversationModel(id: string, model: string): Promise<ConversationSummary>;
	setConversationWebSearch(id: string, enabled: boolean): Promise<ConversationSummary>;
	sendTurn(req: SendTurnRequest): Promise<SendTurnResult>;
	cancelTurn(conversationId: string): Promise<void>;
	setClarificationOpen(id: string, open: boolean): Promise<void>;
	setTheme(theme: Theme): Promise<void>;
	/** Title-bar press: 1 click starts a window drag, 2 toggles maximize. */
	startDrag(clicks: number): Promise<void>;
	onTurnEvent(cb: (e: TurnEventEnvelope) => void): Promise<() => void>;
}

export function inTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function tauriApi(): Api {
	const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
		const { invoke } = await import('@tauri-apps/api/core');
		return invoke<T>(cmd, args);
	};
	return {
		listAgents: () => call('list_agents'),
		listModels: (agent) => call('list_models', { agent }),
		getSettings: () => call('get_settings'),
		updateSettings: (settings) => call('update_settings', { settings }),
		listConversations: (query, tag) => call('list_conversations', { query: query ?? null, tag: tag ?? null }),
		search: (query) => call('search', { query }),
		setPinned: (id, pinned) => call('set_pinned', { id, pinned }),
		setTags: (id, tags) => call('set_tags', { id, tags }),
		listTags: () => call('list_tags'),
		addAttachment: async (name, mime, bytes) => {
			const { invoke } = await import('@tauri-apps/api/core');
			// Raw bytes go in the body; the name is percent-encoded so any file
			// name fits in a header.
			return invoke<Attachment>('add_attachment', bytes, { headers: { 'x-name': encodeURIComponent(name), 'x-mime': mime } });
		},
		removeAttachment: (id) => call('remove_attachment', { id }),
		attachmentUrl: async (att) => {
			const buf = await call<ArrayBuffer>('attachment_bytes', { id: att.id });
			return URL.createObjectURL(new Blob([buf], { type: att.mime }));
		},
		saveTextFile: (defaultName, contents) => call('save_text_file', { defaultName, contents }),
		openArtifact: (name, contents) => call('open_artifact', { name, contents }),
		getConversation: (id) => call('get_conversation', { id }),
		createConversation: (agent, model, webSearch) =>
			call('create_conversation', { agent, model: model ?? null, webSearch: webSearch ?? null }),
		renameConversation: (id, title) => call('rename_conversation', { id, title }),
		deleteConversation: (id) => call('delete_conversation', { id }),
		setConversationModel: (id, model) => call('set_conversation_model', { id, model }),
		setConversationWebSearch: (id, enabled) => call('set_conversation_web_search', { id, enabled }),
		sendTurn: (req) => call('send_turn', { req }),
		cancelTurn: (conversationId) => call('cancel_turn', { conversationId }),
		setClarificationOpen: (id, open) => call('set_clarification_open', { id, open }),
		setTheme: (theme) => call('set_theme', { theme }),
		startDrag: (clicks) => call('start_drag', { clicks }),
		onTurnEvent: async (cb) => {
			const { listen } = await import('@tauri-apps/api/event');
			return listen<TurnEventEnvelope>('turn-event', (ev) => cb(ev.payload));
		}
	};
}

let instance: Api | null = null;

export async function api(): Promise<Api> {
	if (instance) return instance;
	if (inTauri()) {
		instance = tauriApi();
	} else {
		const { mockApi } = await import('./mock');
		instance = mockApi();
	}
	return instance;
}
