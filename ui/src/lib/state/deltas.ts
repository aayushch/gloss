// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Coalesces streamed text deltas before they reach the app state. Agents
// send a delta per few tokens, and every one the UI applies re-parses the
// turn and re-renders its blocks, so chunks are joined and handed on
// together: when a fixed number has gathered, or when the first one has
// waited a short interval, whichever comes first. Every other turn event is
// delivered at once, after any deltas gathered before it, so order holds.

import type { TurnEventEnvelope } from '$lib/api/types';

export interface DeltaBatchOptions {
	/** Deltas delivered together at most; bounds the work one flush causes. */
	maxChunks: number;
	/** Longest a delta waits before it is delivered. */
	maxWaitMs: number;
}

/** Agents stream roughly 10 to 30 deltas a second. A 50 ms wait joins one
 * to two of them at that pace, keeps text moving at about 20 updates a
 * second, and is too short to read as lag. The chunk cap only matters in
 * bursts, such as a resumed session replaying its output. */
export const DELTA_BATCH: DeltaBatchOptions = { maxChunks: 12, maxWaitMs: 50 };

interface Pending {
	conversationId: string;
	turnId: string;
	text: string;
	count: number;
}

export class DeltaBatcher {
	private pending: Pending | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly deliver: (e: TurnEventEnvelope) => void,
		private readonly opts: DeltaBatchOptions = DELTA_BATCH
	) {}

	push(e: TurnEventEnvelope): void {
		if (e.event.type !== 'delta') {
			this.flush();
			this.deliver(e);
			return;
		}
		const p = this.pending;
		if (p && (p.conversationId !== e.conversationId || p.turnId !== e.turnId)) this.flush();
		if (!this.pending) {
			this.pending = { conversationId: e.conversationId, turnId: e.turnId, text: '', count: 0 };
			this.timer = setTimeout(() => this.flush(), this.opts.maxWaitMs);
		}
		this.pending.text += e.event.text;
		this.pending.count += 1;
		if (this.pending.count >= this.opts.maxChunks) this.flush();
	}

	/** Delivers whatever has gathered as one delta. */
	flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const p = this.pending;
		if (!p) return;
		this.pending = null;
		this.deliver({
			conversationId: p.conversationId,
			turnId: p.turnId,
			event: { type: 'delta', text: p.text }
		});
	}
}
