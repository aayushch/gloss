<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Model, token usage, cost, duration and completion time of a finished
	// assistant turn, as a quiet line under the reply. Only the values the
	// agent reported are shown.
	import type { Turn } from '$lib/api/types';

	let { turn }: { turn: Turn } = $props();

	// Formats the time a turn completed, in the user's locale and time zone.
	// A turn completed today shows only the time, for example "15:46".
	// A turn completed on an earlier day of this year also shows the day, for
	// example "Nov 9, 15:46". A turn completed in an earlier year also shows
	// the year.
	function completedLabel(ms: number): string {
		const at = new Date(ms);
		const today = new Date();
		const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
		if (at.toDateString() === today.toDateString()) return at.toLocaleTimeString([], time);
		const sameYear = at.getFullYear() === today.getFullYear();
		return at.toLocaleString([], {
			...time,
			month: 'short',
			day: 'numeric',
			year: sameYear ? undefined : 'numeric'
		});
	}

	const parts = $derived.by(() => {
		const out: string[] = [];
		const u = turn.usage;
		if (turn.model) out.push(turn.model);
		if (u && (u.inputTokens != null || u.outputTokens != null)) {
			out.push(
				`${(u.inputTokens ?? 0).toLocaleString()} in · ${(u.outputTokens ?? 0).toLocaleString()} out`
			);
		}
		if (u?.costUsd != null) out.push(`$${u.costUsd.toFixed(4)}`);
		if (u?.durationMs != null) out.push(`${(u.durationMs / 1000).toFixed(1)}s`);
		if (turn.completedAt != null) out.push(completedLabel(turn.completedAt));
		return out;
	});
</script>

{#if turn.status === 'done' && parts.length}
	<div class="meta">{parts.join(' · ')}</div>
{/if}

<style>
	.meta {
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--text-3);
		margin-top: 6px;
		user-select: none;
	}
</style>
