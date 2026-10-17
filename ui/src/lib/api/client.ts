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
	RequestAnswer,
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
	/** Stores a file already on disk, named by the picker or a drop. */
	addAttachmentPath(path: string): Promise<Attachment>;
	/**
	 * Opens the native file picker and returns the chosen paths, or null when
	 * the page has to use its own file input instead (outside Tauri).
	 */
	pickFiles(): Promise<string[] | null>;
	removeAttachment(id: string): Promise<void>;
	/** A URL the webview can show the attachment from (object URL). */
	attachmentUrl(att: Attachment): Promise<string>;
	/** Native save dialog; resolves to the written path or null if dismissed. */
	saveTextFile(defaultName: string, contents: string): Promise<string | null>;
	/** Writes an artifact to the artifacts folder and opens it with the system's default app. */
	openArtifact(name: string, contents: string): Promise<string>;
	getConversation(id: string): Promise<Conversation>;
	createConversation(agent: AgentId, model?: string, webSearch?: boolean, projectDir?: string | null): Promise<Conversation>;
	/** Opens the native folder picker; null when nothing was chosen. */
	pickFolder(): Promise<string | null>;
	/**
	 * Asks a yes/no question in a native dialog and resolves true when the
	 * user chooses `okLabel`. The webview has no dialogs of its own: a plain
	 * `confirm()` returns false without showing anything.
	 */
	confirm(title: string, message: string, okLabel: string): Promise<boolean>;
	renameConversation(id: string, title: string): Promise<ConversationSummary>;
	deleteConversation(id: string): Promise<void>;
	setConversationModel(id: string, model: string): Promise<ConversationSummary>;
	setConversationWebSearch(id: string, enabled: boolean): Promise<ConversationSummary>;
	/** Sets the working mode of a project-bound conversation; null is read-only. */
	setConversationMode(id: string, mode: string | null): Promise<ConversationSummary>;
	/** Answers the request the running agent is waiting on. */
	answerRequest(conversationId: string, requestId: string, answer: RequestAnswer): Promise<void>;
	sendTurn(req: SendTurnRequest): Promise<SendTurnResult>;
	cancelTurn(conversationId: string): Promise<void>;
	setClarificationOpen(id: string, open: boolean): Promise<void>;
	setTheme(theme: Theme): Promise<void>;
	onTurnEvent(cb: (e: TurnEventEnvelope) => void): Promise<() => void>;
}

/** File types the picker offers; the engine still checks the content. */
export const ATTACHMENT_EXTENSIONS = [
	'png', 'jpg', 'jpeg', 'gif', 'webp',
	'md', 'txt', 'json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log',
	'rs', 'ts', 'js', 'py', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'sh', 'sql', 'html', 'css', 'svelte'
];

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
		addAttachmentPath: (path) => call('add_attachment_path', { path }),
		pickFiles: async () => {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const picked = await open({
				multiple: true,
				title: 'Attach images or text files',
				filters: [{ name: 'Images and text', extensions: ATTACHMENT_EXTENSIONS }]
			});
			return picked ?? [];
		},
		confirm: async (title, message, okLabel) => {
			const { ask } = await import('@tauri-apps/plugin-dialog');
			return ask(message, { title, kind: 'warning', okLabel, cancelLabel: 'Cancel' });
		},
		removeAttachment: (id) => call('remove_attachment', { id }),
		attachmentUrl: async (att) => {
			const buf = await call<ArrayBuffer>('attachment_bytes', { id: att.id });
			return URL.createObjectURL(new Blob([buf], { type: att.mime }));
		},
		saveTextFile: (defaultName, contents) => call('save_text_file', { defaultName, contents }),
		openArtifact: (name, contents) => call('open_artifact', { name, contents }),
		getConversation: (id) => call('get_conversation', { id }),
		createConversation: (agent, model, webSearch, projectDir) =>
			call('create_conversation', { agent, model: model ?? null, webSearch: webSearch ?? null, projectDir: projectDir ?? null }),
		pickFolder: async () => {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const picked = await open({ directory: true, multiple: false, title: 'Choose the project folder' });
			return typeof picked === 'string' ? picked : null;
		},
		renameConversation: (id, title) => call('rename_conversation', { id, title }),
		deleteConversation: (id) => call('delete_conversation', { id }),
		setConversationModel: (id, model) => call('set_conversation_model', { id, model }),
		setConversationWebSearch: (id, enabled) => call('set_conversation_web_search', { id, enabled }),
		setConversationMode: (id, mode) => call('set_conversation_mode', { id, mode }),
		answerRequest: (conversationId, requestId, answer) => call('answer_request', { conversationId, requestId, answer }),
		sendTurn: (req) => call('send_turn', { req }),
		cancelTurn: (conversationId) => call('cancel_turn', { conversationId }),
		setClarificationOpen: (id, open) => call('set_clarification_open', { id, open }),
		setTheme: (theme) => call('set_theme', { theme }),
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
