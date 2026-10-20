// The content script's picture of one page: which asks exist, their turns,
// where each one sits in the DOM, and whether a reply is running. The
// functions here mutate the state in place; the UI re-renders when told.

import type {
	AnchorState,
	Clarification,
	FollowUpResult,
	GetPageResult,
	PageAskResult,
	Turn,
	TurnEventEnvelope,
} from '../shared/protocol';

/** `pending` means the anchor has not been resolved on this page yet. */
export type AskAnchorState = AnchorState | 'pending';

export interface AskEntry {
	clarification: Clarification;
	/** The ask's turns in order: the question, the reply, follow-ups. */
	turns: Turn[];
	range: Range | null;
	state: AskAnchorState;
}

export interface PageState {
	urlKey: string | null;
	conversationId: string | null;
	/** A turn of this page's conversation is running; new asks must wait. */
	running: boolean;
	asks: Map<string, AskEntry>;
}

export function createPageState(): PageState {
	return { urlKey: null, conversationId: null, running: false, asks: new Map() };
}

function turnsOf(turns: Turn[], clarificationId: string): Turn[] {
	return turns.filter((t) => t.clarificationId === clarificationId).sort((a, b) => a.seq - b.seq);
}

/**
 * Replaces the state with what `getPage` returned. Asks that already exist
 * keep their DOM range and anchor state; new ones start `pending`.
 */
export function loadPage(state: PageState, result: GetPageResult): void {
	const { conversation } = result.page;
	const next = new Map<string, AskEntry>();
	for (const cl of conversation.clarifications) {
		if (!cl.webAnchor) continue;
		const old = state.asks.get(cl.id);
		next.set(cl.id, {
			clarification: cl,
			turns: turnsOf(conversation.turns, cl.id),
			range: old?.range ?? null,
			state: old?.state ?? 'pending',
		});
	}
	state.urlKey = result.urlKey;
	state.conversationId = conversation.id;
	state.running = conversation.running;
	state.asks = next;
}

export function clearPage(state: PageState): void {
	state.urlKey = null;
	state.conversationId = null;
	state.running = false;
	state.asks = new Map();
}

/** Adds the ask an `ask` request created. */
export function addAsk(state: PageState, result: PageAskResult, range: Range | null, anchorState: AskAnchorState): AskEntry | null {
	state.urlKey = result.urlKey;
	state.conversationId = result.conversationId;
	state.running = true;
	if (!result.clarification) return null;
	const entry: AskEntry = {
		clarification: result.clarification,
		turns: [result.userTurn, result.assistantTurn],
		range,
		state: anchorState,
	};
	state.asks.set(result.clarification.id, entry);
	return entry;
}

/** Appends the turns a `followUp` request created. */
export function addFollowUp(state: PageState, askId: string, result: FollowUpResult): void {
	const entry = state.asks.get(askId);
	if (!entry) return;
	entry.turns = [...entry.turns, result.userTurn, result.assistantTurn];
	state.running = true;
}

export function removeAsk(state: PageState, askId: string): AskEntry | undefined {
	const entry = state.asks.get(askId);
	state.asks.delete(askId);
	return entry;
}

export function setOpen(state: PageState, askId: string, open: boolean): void {
	const entry = state.asks.get(askId);
	if (entry) entry.clarification = { ...entry.clarification, open };
}

export function setAnchor(state: PageState, askId: string, range: Range | null, anchorState: AskAnchorState): void {
	const entry = state.asks.get(askId);
	if (!entry) return;
	entry.range = range;
	entry.state = anchorState;
}

/**
 * The page's asks in reading order, as the note navigator steps through
 * them: asks found on the page by where their passage starts, then the
 * ones without a passage on the page (orphans, unresolved) by their number.
 */
export function orderedAskIds(state: PageState): string[] {
	const placed: [string, Range][] = [];
	const rest: AskEntry[] = [];
	for (const [id, entry] of state.asks) {
		if (entry.range && entry.state !== 'orphan' && entry.state !== 'pending') placed.push([id, entry.range]);
		else rest.push(entry);
	}
	placed.sort(([, a], [, b]) => {
		try {
			return a.compareBoundaryPoints(Range.START_TO_START, b);
		} catch {
			// Ranges in different documents or detached trees cannot be compared.
			return 0;
		}
	});
	rest.sort((a, b) => a.clarification.number - b.clarification.number || a.clarification.createdAt - b.clarification.createdAt);
	return [...placed.map(([id]) => id), ...rest.map((e) => e.clarification.id)];
}

/** The ask whose turns include `turnId`. */
export function askOfTurn(state: PageState, turnId: string): string | null {
	for (const [id, entry] of state.asks) {
		if (entry.turns.some((t) => t.id === turnId)) return id;
	}
	return null;
}

/** True while an ask's last turn is still being produced. */
export function isStreaming(entry: AskEntry): boolean {
	const last = entry.turns[entry.turns.length - 1];
	return !!last && last.role === 'assistant' && (last.status === 'pending' || last.status === 'streaming');
}

/**
 * Applies a pushed turn event. Returns the id of the ask it changed, or
 * null when the event belongs to no ask on this page (it still updates
 * `running` when the conversation matches).
 */
export function applyTurnEvent(state: PageState, env: TurnEventEnvelope): string | null {
	if (state.conversationId && env.conversationId !== state.conversationId) return null;
	const ev = env.event;
	const terminal = ev.type === 'done' || ev.type === 'failed' || ev.type === 'cancelled';
	if (ev.type === 'started') state.running = true;
	if (terminal) state.running = false;

	const askId = askOfTurn(state, env.turnId);
	if (!askId) return null;
	const entry = state.asks.get(askId)!;
	const i = entry.turns.findIndex((t) => t.id === env.turnId);
	const turn = entry.turns[i];
	let next: Turn | null = null;
	switch (ev.type) {
		case 'started':
			next = { ...turn, status: 'streaming', model: ev.model ?? turn.model };
			break;
		case 'delta':
			next = { ...turn, text: turn.text + ev.text, status: 'streaming' };
			break;
		case 'replace':
			next = { ...turn, text: ev.text, status: 'streaming' };
			break;
		case 'done':
		case 'failed':
		case 'cancelled':
			next = ev.turn;
			break;
		case 'activity':
		case 'request':
		case 'request_resolved':
			return askId;
	}
	if (next) {
		const turns = entry.turns.slice();
		turns[i] = next;
		entry.turns = turns;
	}
	return askId;
}
