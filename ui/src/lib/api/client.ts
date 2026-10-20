// Typed wrappers around the Tauri commands listed in docs/api.md. Outside
// Tauri (plain `vite dev` in a browser) the in-memory mock takes over so the
// UI can be exercised without an engine.

import type {
	AgentId,
	AgentInfo,
	Attachment,
	Conversation,
	BrowserRegistration,
	ConversationSummary,
	ExtensionStatus,
	ExternalSession,
	OpenPageEvent,
	Page,
	PageDetail,
	PageEvent,
	SessionTurn,
	ModelInfo,
	Project,
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
	/** Projects, most recently active first. */
	listProjects(): Promise<Project[]>;
	/** Adds an existing folder as a project; adding one twice returns the existing project. */
	addProject(path: string): Promise<Project>;
	/** Removes a project from the list; its conversations are kept. */
	removeProject(path: string): Promise<void>;
	/** Sessions the agents recorded for the project folder outside Gloss, newest first. */
	listProjectSessions(path: string): Promise<ExternalSession[]>;
	/** The turns of one of those sessions. */
	readProjectSession(path: string, agent: AgentId, id: string): Promise<SessionTurn[]>;
	/** Starts a conversation that resumes one of those sessions in place. */
	continueProjectSession(path: string, agent: AgentId, id: string): Promise<Conversation>;
	/** The turns a continued conversation's session had before Gloss took it over. */
	conversationHistory(id: string): Promise<SessionTurn[]>;
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
	/** Web pages asked about from the browser extension, most recently updated first. */
	listPages(limit: number): Promise<Page[]>;
	/** A page with its conversation, or null when Gloss has no such page. */
	getPage(urlKey: string): Promise<PageDetail | null>;
	/** Removes a page and the conversation that holds its asks. */
	deletePage(urlKey: string): Promise<void>;
	/** Removes one clarification with its turns; nested clarifications go with it. */
	deleteClarification(id: string): Promise<void>;
	/** Where the extension stands: registered browsers, connected sessions, install paths. */
	extensionStatus(): Promise<ExtensionStatus>;
	/** Writes the native-messaging manifests for every installed browser. */
	registerNativeHosts(): Promise<BrowserRegistration[]>;
	unregisterNativeHosts(): Promise<BrowserRegistration[]>;
	/** Opens a URL in the default browser. */
	openUrl(url: string): Promise<void>;
	/** Opens the bundled .xpi with Firefox, which offers to install it. */
	installFirefoxExtension(): Promise<void>;
	/** Opens Safari's extensions preferences. */
	openSafariExtensions(): Promise<void>;
	onPageEvent(cb: (e: PageEvent) => void): Promise<() => void>;
	onSettingsEvent(cb: (s: Settings) => void): Promise<() => void>;
	onOpenPage(cb: (e: OpenPageEvent) => void): Promise<() => void>;
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
		listProjects: () => call('list_projects'),
		addProject: (path) => call('add_project', { path }),
		removeProject: (path) => call('remove_project', { path }),
		listProjectSessions: (path) => call('list_project_sessions', { path }),
		readProjectSession: (path, agent, id) => call('read_project_session', { path, agent, id }),
		continueProjectSession: (path, agent, id) => call('continue_project_session', { path, agent, id }),
		conversationHistory: (id) => call('conversation_history', { id }),
		getConversation: (id) => call('get_conversation', { id }),
		createConversation: (agent, model, webSearch, projectDir) =>
			call('create_conversation', { agent, model: model ?? null, webSearch: webSearch ?? null, projectDir: projectDir ?? null }),
		pickFolder: async () => {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const picked = await open({ directory: true, multiple: false, title: 'Add a project folder' });
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
		},
		listPages: (limit) => call('list_pages', { limit }),
		getPage: (urlKey) => call('get_page', { urlKey }),
		deletePage: (urlKey) => call('delete_page', { urlKey }),
		deleteClarification: (id) => call('delete_clarification', { id }),
		extensionStatus: () => call('extension_status'),
		registerNativeHosts: () => call('register_native_hosts'),
		unregisterNativeHosts: () => call('unregister_native_hosts'),
		openUrl: (url) => call('open_url', { url }),
		installFirefoxExtension: () => call('install_firefox_extension'),
		openSafariExtensions: () => call('open_safari_extensions'),
		onPageEvent: async (cb) => {
			const { listen } = await import('@tauri-apps/api/event');
			return listen<PageEvent>('page-event', (ev) => cb(ev.payload));
		},
		onSettingsEvent: async (cb) => {
			const { listen } = await import('@tauri-apps/api/event');
			return listen<Settings>('settings-event', (ev) => cb(ev.payload));
		},
		onOpenPage: async (cb) => {
			const { listen } = await import('@tauri-apps/api/event');
			return listen<OpenPageEvent>('open-page', (ev) => cb(ev.payload));
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
