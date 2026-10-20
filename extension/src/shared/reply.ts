// Follows one assistant turn through pushed turn events, for the popup and
// the ask window which show a single reply at a time.

import type { Turn, TurnEventEnvelope } from './protocol';

/** Applies a turn event to `turn`, returning the updated turn or the same object when the event is not about it. */
export function applyToTurn(turn: Turn, env: TurnEventEnvelope): Turn {
	if (env.turnId !== turn.id) return turn;
	const ev = env.event;
	switch (ev.type) {
		case 'started':
			return { ...turn, status: 'streaming', model: ev.model ?? turn.model };
		case 'delta':
			return { ...turn, text: turn.text + ev.text, status: 'streaming' };
		case 'replace':
			return { ...turn, text: ev.text, status: 'streaming' };
		case 'done':
		case 'failed':
		case 'cancelled':
			return ev.turn;
		default:
			return turn;
	}
}

export function isLive(turn: Turn | null): boolean {
	return !!turn && (turn.status === 'pending' || turn.status === 'streaming');
}
