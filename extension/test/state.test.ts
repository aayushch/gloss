import { describe, expect, it } from 'vitest';
import type { Clarification, GetPageResult, Turn, TurnEventEnvelope } from '../src/shared/protocol';
import { addAsk, applyTurnEvent, createPageState, isStreaming, loadPage, removeAsk, setOpen } from '../src/content/state';

function turn(id: string, role: 'user' | 'assistant', text: string, clarificationId: string | null, status: Turn['status'] = 'done'): Turn {
	return {
		id,
		conversationId: 'conv',
		seq: Number(id.replace(/\D/g, '')),
		role,
		text,
		promptText: null,
		status,
		clarificationId,
		model: null,
		error: null,
		usage: null,
		createdAt: 0,
		completedAt: null,
		attachments: [],
	};
}

function clarification(id: string, open = true): Clarification {
	return {
		id,
		conversationId: 'conv',
		number: 1,
		anchorBlockId: 't1:0',
		quote: 'quote',
		parentId: null,
		open,
		createdAt: 0,
		webAnchor: { quote: { exact: 'quote', prefix: '', suffix: '' }, position: null, container: null },
		anchorState: null,
	};
}

function pageResult(): GetPageResult {
	return {
		urlKey: 'https://example.com/a',
		page: {
			page: { urlKey: 'https://example.com/a', url: 'https://example.com/a', title: 'A', faviconUrl: null, conversationId: 'conv', askCount: 1, orphanCount: 0, firstSeen: 0, lastSeen: 0, updatedAt: 0 },
			conversation: {
				id: 'conv',
				title: 'A',
				agent: 'claude',
				model: '',
				running: true,
				pendingRequest: null,
				turns: [turn('t1', 'user', 'why?', 'c1'), turn('t2', 'assistant', 'Because', 'c1', 'streaming'), turn('t3', 'user', 'page q', null)],
				clarifications: [clarification('c1')],
			},
		},
	};
}

function env(turnId: string, event: TurnEventEnvelope['event']): TurnEventEnvelope {
	return { conversationId: 'conv', turnId, event };
}

describe('page state', () => {
	it('loads asks with their turns and keeps existing anchors', () => {
		const s = createPageState();
		loadPage(s, pageResult());
		expect(s.urlKey).toBe('https://example.com/a');
		expect(s.conversationId).toBe('conv');
		expect(s.running).toBe(true);
		const ask = s.asks.get('c1')!;
		expect(ask.turns.map((t) => t.id)).toEqual(['t1', 't2']);
		expect(ask.state).toBe('pending');
		ask.state = 'anchored';
		loadPage(s, pageResult());
		expect(s.asks.get('c1')!.state).toBe('anchored');
	});

	it('appends deltas, replaces text and finishes with the final turn', () => {
		const s = createPageState();
		loadPage(s, pageResult());
		expect(applyTurnEvent(s, env('t2', { type: 'delta', text: ' the' }))).toBe('c1');
		expect(applyTurnEvent(s, env('t2', { type: 'delta', text: ' buffer' }))).toBe('c1');
		expect(s.asks.get('c1')!.turns[1].text).toBe('Because the buffer');
		expect(isStreaming(s.asks.get('c1')!)).toBe(true);
		applyTurnEvent(s, env('t2', { type: 'replace', text: 'Rewritten' }));
		expect(s.asks.get('c1')!.turns[1].text).toBe('Rewritten');
		const final = turn('t2', 'assistant', 'Rewritten.', 'c1', 'done');
		applyTurnEvent(s, env('t2', { type: 'done', turn: final }));
		expect(s.asks.get('c1')!.turns[1]).toEqual(final);
		expect(s.running).toBe(false);
		expect(isStreaming(s.asks.get('c1')!)).toBe(false);
	});

	it('marks failed and cancelled turns and ignores other conversations', () => {
		const s = createPageState();
		loadPage(s, pageResult());
		expect(applyTurnEvent(s, { conversationId: 'other', turnId: 't2', event: { type: 'delta', text: 'x' } })).toBeNull();
		expect(s.asks.get('c1')!.turns[1].text).toBe('Because');
		applyTurnEvent(s, env('t2', { type: 'failed', error: 'boom', turn: turn('t2', 'assistant', 'Because', 'c1', 'error') }));
		expect(s.asks.get('c1')!.turns[1].status).toBe('error');
		expect(s.running).toBe(false);
	});

	it('tracks running for turns that belong to no ask', () => {
		const s = createPageState();
		loadPage(s, pageResult());
		expect(applyTurnEvent(s, env('t4', { type: 'done', turn: turn('t4', 'assistant', 'page reply', null) }))).toBeNull();
		expect(s.running).toBe(false);
		applyTurnEvent(s, env('t4', { type: 'started', sessionId: null, model: null }));
		expect(s.running).toBe(true);
	});

	it('adds, collapses and removes asks', () => {
		const s = createPageState();
		const entry = addAsk(
			s,
			{ urlKey: 'k', conversationId: 'conv', clarification: clarification('c9'), userTurn: turn('t8', 'user', 'q', 'c9'), assistantTurn: turn('t9', 'assistant', '', 'c9', 'pending') },
			null,
			'anchored',
		)!;
		expect(s.running).toBe(true);
		expect(entry.turns.length).toBe(2);
		setOpen(s, 'c9', false);
		expect(s.asks.get('c9')!.clarification.open).toBe(false);
		expect(removeAsk(s, 'c9')).toBe(entry);
		expect(s.asks.size).toBe(0);
	});
});
