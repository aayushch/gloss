// Wire types of the Gloss bridge protocol, mirrored by hand from
// engine/src/bridge/protocol.rs, engine/src/bridge/handler.rs and
// engine/src/types.rs. Every field is camelCase on the wire.

/** Protocol version this extension speaks. */
export const PROTOCOL = 1;

/** Name of the native-messaging host that relays to Gloss. */
export const NATIVE_HOST = 'sh.aay.gloss';

export type ErrorCode =
	| 'protocol'
	| 'unauthorized'
	| 'busy'
	| 'not_found'
	| 'denied'
	| 'invalid'
	| 'internal'
	| 'app_not_running';

export interface BridgeError {
	code: ErrorCode;
	message: string;
}

export interface BridgeRequest {
	id: string;
	method: string;
	params?: unknown;
}

export type BridgeIncoming =
	| { id: string; result: unknown }
	| { id: string; error: BridgeError }
	| { event: string; data: unknown };

/** Error thrown by transports and clients; carries the bridge error code. */
export class BridgeFailure extends Error {
	code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = 'BridgeFailure';
		this.code = code;
	}
}

export function isBridgeFailure(e: unknown): e is BridgeFailure {
	return e instanceof BridgeFailure || (typeof e === 'object' && e !== null && 'code' in e && 'message' in e);
}

export function failureOf(e: unknown): BridgeFailure {
	if (e instanceof BridgeFailure) return e;
	if (isBridgeFailure(e)) return new BridgeFailure(e.code, e.message);
	return new BridgeFailure('internal', e instanceof Error ? e.message : String(e));
}

// ---- data types -------------------------------------------------------

export type Role = 'user' | 'assistant';
export type TurnStatus = 'pending' | 'streaming' | 'done' | 'error' | 'cancelled';
export type AnchorState = 'anchored' | 'fuzzy' | 'orphan';
export type ActivityKind = 'thinking' | 'tool' | 'status';

export interface Usage {
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	durationMs: number | null;
}

export interface Attachment {
	id: string;
	name: string;
	mime: string;
	kind: 'image' | 'text';
	size: number;
	path: string;
	turnId: string | null;
	createdAt: number;
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
	attachments: Attachment[];
	/** Set when the bridge cut the text to fit a frame; Gloss has the rest. */
	truncated?: boolean;
}

export interface TextQuoteSelector {
	exact: string;
	prefix: string;
	suffix: string;
}

export interface TextPositionSelector {
	start: number;
	end: number;
}

/** Where a passage sits on its page, in the terms of the W3C annotation selectors. */
export interface WebAnchor {
	quote: TextQuoteSelector;
	/** Offsets into the page's normalised text when the ask was made. */
	position: TextPositionSelector | null;
	/** Short CSS path of the block element the passage started in. */
	container: string | null;
}

export interface Clarification {
	id: string;
	conversationId: string;
	number: number;
	anchorBlockId: string;
	quote: string;
	parentId: string | null;
	open: boolean;
	createdAt: number;
	webAnchor?: WebAnchor | null;
	anchorState?: AnchorState | null;
}

export interface AskContext {
	before: string;
	after: string;
}

export interface Page {
	urlKey: string;
	url: string;
	title: string;
	faviconUrl: string | null;
	conversationId: string;
	askCount: number;
	orphanCount: number;
	firstSeen: number;
	lastSeen: number;
	updatedAt: number;
}

export interface ModeSuggestion {
	mode: string;
	label: string;
}

export interface Question {
	question: string;
	header: string;
	options: { label: string; description: string }[];
	multiSelect: boolean;
}

export type AgentRequest = { id: string } & (
	| { kind: 'permission'; tool: string; title: string; detail: string | null; suggestions: ModeSuggestion[] }
	| { kind: 'question'; questions: Question[] }
);

/** The conversation fields the extension reads; Gloss sends more. */
export interface Conversation {
	id: string;
	title: string;
	agent: string;
	model: string;
	running: boolean;
	pendingRequest: AgentRequest | null;
	turns: Turn[];
	clarifications: Clarification[];
	pageKey?: string | null;
}

export interface PageDetail {
	page: Page;
	conversation: Conversation;
}

export interface PageMeta {
	url: string;
	title: string;
	faviconUrl?: string | null;
}

export interface PageAskRequest {
	page: PageMeta;
	anchor: WebAnchor | null;
	context: AskContext;
	question: string;
	pageText?: string | null;
	private: boolean;
}

export interface PageAskResult {
	urlKey: string;
	conversationId: string;
	clarification: Clarification | null;
	userTurn: Turn;
	assistantTurn: Turn;
}

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

// ---- method results ---------------------------------------------------

export interface ExtensionSettings {
	sendPageText: boolean;
	/** Hosts the extension stays silent on: exact hosts or `*.example.com`. */
	denyList: string[];
}

export const DEFAULT_SETTINGS: ExtensionSettings = { sendPageText: true, denyList: [] };

export interface HelloParams {
	protocol: number;
	extensionVersion: string;
	browser: string;
	userAgent: string;
}

export interface HelloResult {
	protocol: number;
	minProtocol: number;
	appVersion: string;
	settings: ExtensionSettings;
	agent: string;
}

export interface GetPageResult {
	urlKey: string;
	page: PageDetail;
}

export interface GetTurnResult {
	turn: Turn;
	running: boolean;
	request: AgentRequest | null;
}

export interface FollowUpResult {
	userTurn: Turn;
	assistantTurn: Turn;
}

export interface ListRecentPagesResult {
	pages: Page[];
}

/** Answered by the native host itself, not by Gloss. */
export interface LaunchAppResult {
	launched: boolean;
	running: boolean;
}

export interface PageEventData {
	urlKey: string;
	deleted: boolean;
}

export interface AppStateEventData {
	running: boolean;
}

/** True when `host` matches a deny-list pattern (`example.com` or `*.example.com`). */
export function isDeniedHost(host: string, denyList: string[]): boolean {
	const h = host.toLowerCase();
	for (const raw of denyList) {
		const p = raw.trim().toLowerCase();
		if (!p) continue;
		if (p.startsWith('*.')) {
			const base = p.slice(2);
			if (h === base || h.endsWith('.' + base)) return true;
		} else if (h === p) {
			return true;
		}
	}
	return false;
}
