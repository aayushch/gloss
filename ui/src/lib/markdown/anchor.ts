// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Splits a block's inline runs at mark boundaries so a highlighted quote can
// be rendered without losing the bold / code / italic formatting underneath.

import type { Run } from './blocks';

export interface Mark {
	/** Offset into the block's plain text. */
	start: number;
	len: number;
	/** Clarification id, or a sentinel for the composer's temporary mark. */
	id: string;
}

export interface Segment {
	t: string;
	run: Run;
	/** Set when the segment lies inside a mark. */
	markId?: string;
}

/** First occurrence of the quote in the block text, or -1 when absent. */
export function resolveMark(blockText: string, quote: string): number {
	if (!quote) return -1;
	const i = blockText.indexOf(quote);
	if (i >= 0) return i;
	// Tolerate whitespace differences between the selection and the text.
	const norm = quote.replace(/\s+/g, ' ').trim();
	return norm ? blockText.replace(/\s+/g, ' ').indexOf(norm) : -1;
}

export function segmentRuns(runs: Run[], marks: Mark[]): Segment[] {
	const text = runs.map((r) => r.t).join('');
	const valid = marks
		.filter((m) => m.start >= 0 && m.len > 0 && m.start < text.length)
		.sort((a, b) => a.start - b.start);
	const bounds = new Set<number>([0, text.length]);
	const runAt: { s: number; e: number; r: Run }[] = [];
	let off = 0;
	for (const r of runs) {
		runAt.push({ s: off, e: off + r.t.length, r });
		bounds.add(off);
		off += r.t.length;
	}
	for (const m of valid) {
		bounds.add(m.start);
		bounds.add(Math.min(m.start + m.len, text.length));
	}
	const bs = [...bounds].sort((a, b) => a - b);
	const segs: Segment[] = [];
	for (let i = 0; i < bs.length - 1; i++) {
		const a = bs[i];
		const b = bs[i + 1];
		if (b <= a) continue;
		const run = runAt.find((x) => a >= x.s && a < x.e)?.r ?? { t: '' };
		// Earliest mark covering this offset wins when marks overlap.
		const m = valid.find((x) => a >= x.start && a < x.start + x.len);
		segs.push({ t: text.slice(a, b), run, markId: m?.id });
	}
	return segs;
}
