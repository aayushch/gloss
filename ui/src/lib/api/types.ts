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
	createdAt: number;
	updatedAt: number;
}

export interface Conversation extends ConversationSummary {
	agentSessionId: string | null;
	running: boolean;
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

export type TurnEvent =
	| { type: 'started'; sessionId: string | null; model: string | null }
	| { type: 'delta'; text: string }
	| { type: 'replace'; text: string }
	| { type: 'activity'; kind: ActivityKind; label: string }
	| { type: 'done'; turn: Turn }
	| { type: 'failed'; error: string; turn: Turn }
	| { type: 'cancelled'; turn: Turn };

export interface TurnEventEnvelope {
	conversationId: string;
	turnId: string;
	event: TurnEvent;
}
