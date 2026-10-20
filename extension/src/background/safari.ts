// Transport for Safari, where the native handler answers one message at a
// time through `sendNativeMessage` and cannot push anything. Replies that
// are still being written are followed by polling `getTurn` every 500 ms
// and turning what comes back into the same `turn` events the native port
// transport would have delivered.

import { browser } from '../shared/browser';
import {
	BridgeFailure,
	type AgentRequest,
	type BridgeIncoming,
	type GetTurnResult,
	type PageAskResult,
	type Turn,
	type TurnEventEnvelope,
} from '../shared/protocol';
import { Emitter, type Transport, type TransportState } from './transport';

const POLL_MS = 500;
/** Polling stops after this long even if the turn never reports an end. */
const POLL_MAX_MS = 10 * 60_000;

/** Methods whose result carries a new assistant turn to follow. */
const TURN_STARTERS = new Set(['ask', 'askPage', 'followUp']);

interface Poll {
	timer: ReturnType<typeof setTimeout> | null;
	startedAt: number;
	lastText: string;
	request: AgentRequest | null;
}

export class SafariTransport implements Transport {
	readonly pushesEvents = false;
	state: TransportState = 'connected';
	private nextId = 1;
	private readonly polls = new Map<string, Poll>();
	private readonly emitter = new Emitter();

	connect(): void {
		// Each message opens its own exchange; nothing to keep open.
	}

	async request(method: string, params?: unknown): Promise<unknown> {
		const id = String(this.nextId++);
		let reply: BridgeIncoming;
		try {
			reply = (await browser.runtime.sendNativeMessage('application.id', { id, method, params })) as BridgeIncoming;
		} catch (e) {
			throw new BridgeFailure('app_not_running', e instanceof Error ? e.message : 'the Gloss handler did not answer');
		}
		if (!reply || typeof reply !== 'object') throw new BridgeFailure('internal', 'empty reply from the Gloss handler');
		if ('error' in reply) throw new BridgeFailure(reply.error.code, reply.error.message);
		if ('event' in reply) throw new BridgeFailure('internal', 'unexpected event reply');
		if (TURN_STARTERS.has(method)) this.follow(reply.result as PageAskResult);
		return reply.result;
	}

	onEvent(handler: (event: string, data: unknown) => void): () => void {
		return this.emitter.onEvent(handler);
	}

	onStateChange(handler: (state: TransportState, detail?: string) => void): () => void {
		return this.emitter.onStateChange(handler);
	}

	/** Starts polling the assistant turn a request created. */
	private follow(result: { assistantTurn?: Turn } | null): void {
		const turn = result?.assistantTurn;
		if (!turn || this.polls.has(turn.id)) return;
		const poll: Poll = { timer: null, startedAt: Date.now(), lastText: turn.text ?? '', request: null };
		this.polls.set(turn.id, poll);
		this.emitter.emit('turn', envelope(turn, { type: 'started', sessionId: null, model: turn.model }));
		poll.timer = setTimeout(() => this.tick(turn.id), POLL_MS);
	}

	private async tick(turnId: string): Promise<void> {
		const poll = this.polls.get(turnId);
		if (!poll) return;
		poll.timer = null;
		let res: GetTurnResult;
		try {
			res = (await this.request('getTurn', { turnId })) as GetTurnResult;
		} catch {
			if (Date.now() - poll.startedAt > POLL_MAX_MS) {
				this.polls.delete(turnId);
				return;
			}
			poll.timer = setTimeout(() => this.tick(turnId), POLL_MS * 2);
			return;
		}
		const { turn, running, request } = res;
		if (turn.text !== poll.lastText) {
			poll.lastText = turn.text;
			this.emitter.emit('turn', envelope(turn, { type: 'replace', text: turn.text }));
		}
		if (request && request.id !== poll.request?.id) {
			poll.request = request;
			this.emitter.emit('turn', envelope(turn, { type: 'request', request }));
		} else if (!request && poll.request) {
			this.emitter.emit('turn', envelope(turn, { type: 'request_resolved', requestId: poll.request.id }));
			poll.request = null;
		}
		const ended = turn.status === 'done' || turn.status === 'error' || turn.status === 'cancelled';
		if (ended || (!running && turn.status !== 'pending') || Date.now() - poll.startedAt > POLL_MAX_MS) {
			this.polls.delete(turnId);
			if (turn.status === 'error') this.emitter.emit('turn', envelope(turn, { type: 'failed', error: turn.error ?? 'failed', turn }));
			else if (turn.status === 'cancelled') this.emitter.emit('turn', envelope(turn, { type: 'cancelled', turn }));
			else this.emitter.emit('turn', envelope(turn, { type: 'done', turn: { ...turn, status: 'done' } }));
			return;
		}
		poll.timer = setTimeout(() => this.tick(turnId), POLL_MS);
	}
}

function envelope(turn: Turn, event: TurnEventEnvelope['event']): TurnEventEnvelope {
	return { conversationId: turn.conversationId, turnId: turn.id, event };
}
