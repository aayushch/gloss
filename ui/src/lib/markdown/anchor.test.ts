// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { resolveMark, segmentRuns } from './anchor';
import type { Run } from './blocks';

const runs: Run[] = [
	{ t: 'The ' },
	{ t: 'quick', b: true },
	{ t: ' brown ' },
	{ t: 'fox', code: true },
	{ t: ' jumps.' }
];
// text: "The quick brown fox jumps."

describe('resolveMark', () => {
	it('finds the first occurrence', () => {
		expect(resolveMark('a b a b', 'b')).toBe(2);
	});
	it('returns -1 when absent', () => {
		expect(resolveMark('hello', 'xyz')).toBe(-1);
		expect(resolveMark('hello', '')).toBe(-1);
	});
});

describe('segmentRuns', () => {
	it('returns the runs unchanged without marks', () => {
		const segs = segmentRuns(runs, []);
		expect(segs.map((s) => s.t)).toEqual(['The ', 'quick', ' brown ', 'fox', ' jumps.']);
		expect(segs.every((s) => !s.markId)).toBe(true);
	});

	it('splits runs at mark boundaries and keeps formatting', () => {
		// mark "quick brown f" (4..17)
		const segs = segmentRuns(runs, [{ start: 4, len: 13, id: 'c1' }]);
		expect(segs.map((s) => [s.t, s.markId ?? null])).toEqual([
			['The ', null],
			['quick', 'c1'],
			[' brown ', 'c1'],
			['f', 'c1'],
			['ox', null],
			[' jumps.', null]
		]);
		expect(segs[1].run.b).toBe(true);
		expect(segs[3].run.code).toBe(true);
		expect(segs[4].run.code).toBe(true);
	});

	it('gives overlapping marks to the earlier one', () => {
		const segs = segmentRuns(runs, [
			{ start: 10, len: 9, id: 'late' },
			{ start: 4, len: 11, id: 'early' }
		]);
		const marked = segs.filter((s) => s.markId);
		expect(marked.map((s) => s.markId)).toEqual(['early', 'early', 'early', 'late', 'late']);
		expect(marked.map((s) => s.t).join('')).toBe('quick brown fox');
	});

	it('ignores marks that do not resolve', () => {
		const segs = segmentRuns(runs, [{ start: -1, len: 5, id: 'x' }]);
		expect(segs.every((s) => !s.markId)).toBe(true);
	});

	it('clamps marks that run past the end', () => {
		const segs = segmentRuns(runs, [{ start: 20, len: 50, id: 'x' }]);
		expect(segs[segs.length - 1]).toMatchObject({ t: 'jumps.', markId: 'x' });
	});
});
