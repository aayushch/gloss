// Mirror of engine/src/types.rs. Field names are camelCase on both sides;
// enums are snake_case strings. Keep the two files in sync.

export type AgentId = 'claude' | 'codex' | 'gemini' | 'pi' | 'cursor';

export interface AgentInfo {
	id: AgentId;
	name: string;
	command: string;
	monogram: string;
	available: boolean;
	path: string | null;
	version: string | null;
	supportsModelSelect: boolean;
	supportsWebSearch: boolean;
	/** Modes the CLI offers for project-bound conversations; read-only is implied and not listed. */
	modes: AgentMode[];
	/** True when the agent's permission prompts and questions reach the user as cards. */
	supportsRequests: boolean;
}

export interface ModelInfo {
	id: string;
	name: string;
	note: string | null;
	context: string | null;
	isDefault: boolean;
}

export type Theme = 'light' | 'dark';

export interface Settings {
	defaultAgent: AgentId;
	defaultModel: Partial<Record<AgentId, string>>;
	theme: Theme;
	webSearch: boolean;
}

export type Role = 'user' | 'assistant';
export type TurnStatus = 'pending' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface Usage {
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	durationMs: number | null;
}

export interface Turn {
	id: string;
	conversationId: string;
	seq: number;
	role: Role;
	text: string;
	promptText: string | null;
	status: TurnStatus;
	clarificationId: string | null;
	model: string | null;
	error: string | null;
	usage: Usage | null;
	createdAt: number;
	completedAt: number | null;
	/** User turns only: files sent with the message. */
	attachments: Attachment[];
}

export type AttachmentKind = 'image' | 'text';

export interface Attachment {
	id: string;
	name: string;
	mime: string;
	kind: AttachmentKind;
	size: number;
	path: string;
	/** Set once the attachment has been sent with a user turn. */
	turnId: string | null;
	createdAt: number;
}

/** One full-text search hit; `turnId` is null when only the title matched. */
export interface SearchHit {
	conversationId: string;
	title: string;
	agent: AgentId;
	turnId: string | null;
	role: Role | null;
	clarificationId: string | null;
	/** Matched words are wrapped in \u0001 and \u0002. */
	snippet: string;
	updatedAt: number;
}

export interface Clarification {
	id: string;
	conversationId: string;
	number: number;
	/** `<turnId>:<blockIndex>` of the block that contains the quote. */
	anchorBlockId: string;
	quote: string;
	parentId: string | null;
	open: boolean;
	createdAt: number;
}

export interface ConversationSummary {
	id: string;
	title: string;
	agent: AgentId;
	model: string;
	webSearch: boolean;
	pinned: boolean;
	tags: string[];
	clarificationCount: number;
	/** Absolute path of the project folder the agent runs in; null means the Gloss workspace. */
	projectDir: string | null;
	/** The agent's working mode inside the folder, an id from AgentInfo.modes; null is read-only. */
	mode: string | null;
	createdAt: number;
	updatedAt: number;
}

/** A folder the user added as a project; conversations whose projectDir equals path belong to it. */
export interface Project {
	/** Canonical absolute path of the folder. */
	path: string;
	/** The folder's last path segment. */
	name: string;
	createdAt: number;
	/** The later of createdAt and the newest update to one of its conversations. */
	lastActiveAt: number;
}

/** Where a session Gloss did not start was run from, as the agent's files record it. */
export type SessionOrigin = 'terminal' | 'ide' | 'desktop' | 'headless';

/** An agent session found in the agent's own history for a project folder, not held by any Gloss conversation. */
export interface ExternalSession {
	agent: AgentId;
	/** The agent's own session id. */
	id: string;
	/** The title the agent gave the session, or else its first prompt. */
	title: string;
	/** Null when the agent's files do not record it. */
	origin: SessionOrigin | null;
	/** The file the session was read from. */
	file: string;
	createdAt: number;
	/** When the session file was last written. */
	updatedAt: number;
}

export interface Conversation extends ConversationSummary {
	agentSessionId: string | null;
	running: boolean;
	/** The request the running agent is waiting on, if any. */
	pendingRequest: AgentRequest | null;
	turns: Turn[];
	clarifications: Clarification[];
}

export type ClarificationTarget =
	| { kind: 'new'; anchorBlockId: string; quote: string; parentId: string | null }
	| { kind: 'existing'; clarificationId: string };

export interface SendTurnRequest {
	conversationId: string;
	text: string;
	clarification: ClarificationTarget | null;
	/** Ids of staged attachments to send with the turn. */
	attachments: string[];
}

export interface SendTurnResult {
	userTurn: Turn;
	assistantTurn: Turn;
	clarification: Clarification | null;
}

export type ActivityKind = 'thinking' | 'tool' | 'status';

/** One way of running an agent inside a project folder, as its CLI names it. */
export interface AgentMode {
	id: string;
	label: string;
	description: string;
	/** True when the agent may change files in this mode. */
	writes: boolean;
}

export interface ModeSuggestion {
	mode: string;
	label: string;
}

export interface QuestionOption {
	label: string;
	description: string;
}

export interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

/** Something the agent needs from the user before it can go on. */
export type AgentRequest = { id: string } & (
	| { kind: 'permission'; tool: string; title: string; detail: string | null; suggestions: ModeSuggestion[] }
	| { kind: 'question'; questions: Question[] }
);

export type RequestAnswer =
	| { kind: 'permission'; allow: boolean; message: string | null; setMode: string | null }
	| { kind: 'question'; answers: Record<string, string> };

export type TurnEvent =
	| { type: 'started'; sessionId: string | null; model: string | null }
	| { type: 'delta'; text: string }
	| { type: 'replace'; text: string }
	| { type: 'activity'; kind: ActivityKind; label: string }
	| { type: 'request'; request: AgentRequest }
	| { type: 'request_resolved'; requestId: string }
	| { type: 'done'; turn: Turn }
	| { type: 'failed'; error: string; turn: Turn }
	| { type: 'cancelled'; turn: Turn };

export interface TurnEventEnvelope {
	conversationId: string;
	turnId: string;
	event: TurnEvent;
}
