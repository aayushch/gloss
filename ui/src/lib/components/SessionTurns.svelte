<script lang="ts">
	// Read-only turns of a session read from an agent's own history file:
	// prompts as bubbles, replies as markdown, and each reply's tool calls
	// folded into one line that opens to list them. Nothing here can be
	// selected for a clarification; these turns are not stored in Gloss.
	import type { SessionTurn } from '$lib/api/types';
	import MarkdownView from './MarkdownView.svelte';

	let { turns }: { turns: SessionTurn[] } = $props();
</script>

{#each turns as t, i (i)}
	{#if t.role === 'user'}
		<div class="row">
			<div class="bubble">{t.text}</div>
		</div>
	{:else}
		<div class="reply">
			{#if t.tools.length}
				<details class="tools">
					<summary>{t.tools.length} tool call{t.tools.length === 1 ? '' : 's'}</summary>
					<ul>
						{#each t.tools as label, j (j)}<li class="mono">{label}</li>{/each}
					</ul>
				</details>
			{/if}
			{#if t.text}<MarkdownView text={t.text} />{/if}
		</div>
	{/if}
{/each}

<style>
	.row {
		display: flex;
		justify-content: flex-end;
		margin: 4px 0 18px;
	}
	.bubble {
		max-width: 78%;
		background: var(--surface);
		padding: 10px 14px;
		font-size: 14px;
		line-height: 1.5;
		border-radius: 14px 14px 4px 14px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.reply {
		margin-bottom: 26px;
	}
	.tools {
		font-size: 12px;
		color: var(--text-3);
		margin-bottom: 8px;
	}
	.tools summary {
		cursor: pointer;
		width: fit-content;
	}
	.tools summary:hover {
		color: var(--text-2);
	}
	.tools ul {
		margin: 6px 0 0;
		padding-left: 18px;
	}
	.tools li {
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 1.6;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
