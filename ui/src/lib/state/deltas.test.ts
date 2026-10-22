import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEventEnvelope } from '$lib/api/types';
import { DeltaBatcher } from './deltas';

const delta = (text: string, turnId = 't1'): TurnEventEnvelope => ({ conversationId: 'c', turnId, event: { type: 'delta', text } });

describe('DeltaBatcher', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('joins deltas and delivers them when the wait elapses', () => {
		const out: TurnEventEnvelope[] = [];
		const b = new DeltaBatcher((e) => out.push(e), { maxChunks: 10, maxWaitMs: 50 });
		b.push(delta('a'));
		b.push(delta('b'));
		expect(out).toHaveLength(0);
		vi.advanceTimersByTime(49);
		expect(out).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(out).toEqual([delta('ab')]);
	});

	it('delivers as soon as the chunk cap is reached', () => {
		const out: TurnEventEnvelope[] = [];
		const b = new DeltaBatcher((e) => out.push(e), { maxChunks: 3, maxWaitMs: 50 });
		b.push(delta('a'));
		b.push(delta('b'));
		b.push(delta('c'));
		expect(out).toEqual([delta('abc')]);
		b.push(delta('d'));
		vi.advanceTimersByTime(50);
		expect(out).toEqual([delta('abc'), delta('d')]);
	});

	it('flushes gathered deltas before any other event so order holds', () => {
		const out: TurnEventEnvelope[] = [];
		const b = new DeltaBatcher((e) => out.push(e), { maxChunks: 10, maxWaitMs: 50 });
		const done: TurnEventEnvelope = { conversationId: 'c', turnId: 't1', event: { type: 'activity', kind: 'thinking', label: 'x' } as never };
		b.push(delta('a'));
		b.push(done);
		expect(out).toEqual([delta('a'), done]);
		vi.advanceTimersByTime(50);
		expect(out).toHaveLength(2);
	});

	it('keeps deltas of different turns apart', () => {
		const out: TurnEventEnvelope[] = [];
		const b = new DeltaBatcher((e) => out.push(e), { maxChunks: 10, maxWaitMs: 50 });
		b.push(delta('a', 't1'));
		b.push(delta('b', 't2'));
		expect(out).toEqual([delta('a', 't1')]);
		vi.advanceTimersByTime(50);
		expect(out).toEqual([delta('a', 't1'), delta('b', 't2')]);
	});
});
