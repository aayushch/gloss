<script lang="ts">
	// Model, token usage, cost and duration of a finished assistant turn, as a
	// quiet line under the reply. Only the values the agent reported are shown.
	import type { Turn } from '$lib/api/types';

	let { turn }: { turn: Turn } = $props();

	const parts = $derived.by(() => {
		const out: string[] = [];
		const u = turn.usage;
		if (turn.model) out.push(turn.model);
		if (u && (u.inputTokens != null || u.outputTokens != null)) {
			out.push(`${(u.inputTokens ?? 0).toLocaleString()} in · ${(u.outputTokens ?? 0).toLocaleString()} out`);
		}
		if (u?.costUsd != null) out.push(`$${u.costUsd.toFixed(4)}`);
		if (u?.durationMs != null) out.push(`${(u.durationMs / 1000).toFixed(1)}s`);
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
