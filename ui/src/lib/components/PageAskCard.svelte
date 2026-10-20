<script lang="ts">
	// One ask made on a web page: the highlighted passage with the text
	// around it dimmed, how well the extension still finds it on the page,
	// a remove button, and the clarification well with the questions and
	// answers under it.
	import { api } from '$lib/api/client';
	import type { Conversation } from '$lib/api/types';
	import { app } from '$lib/state/app.svelte';
	import { anchorLabel, type Thread } from '$lib/state/threads';
	import Icon from './Icon.svelte';
	import Well from './Well.svelte';

	let { thread, conv, threads }: { thread: Thread; conv: Conversation; threads: Map<string, Thread> } = $props();

	const cl = $derived(thread.clarification);
	const anchor = $derived(cl.webAnchor);
	const state = $derived(anchorLabel(cl.anchorState));

	async function confirmRemove() {
		const yes = await (await api()).confirm('Remove this ask?', 'The question, its answers and any follow-ups are removed from Gloss.', 'Remove');
		if (yes) app.removeAsk(cl.id);
	}
</script>

<section class="ask" class:orphan={cl.anchorState === 'orphan'}>
	<blockquote class="passage">
		{#if anchor?.quote.prefix}<span class="around">{anchor.quote.prefix}</span>{/if}<span class="exact">{anchor?.quote.exact ?? cl.quote}</span>{#if anchor?.quote.suffix}<span class="around">{anchor.quote.suffix}</span>{/if}
	</blockquote>
	<div class="bar">
		{#if state}<span class="state">{state}</span>{/if}
		<span class="spacer"></span>
		<button type="button" class="rm" title="Remove this ask" aria-label="Remove this ask" onclick={confirmRemove}><Icon name="trash" size={12} /></button>
	</div>
	<Well {thread} {conv} {threads} depth={1} />
</section>

<style>
	.ask {
		margin: 0 0 22px;
	}
	.passage {
		margin: 0;
		padding: 2px 0 2px 14px;
		border-left: 3px solid var(--accent);
		font-size: 14px;
		line-height: 1.55;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.orphan .passage {
		border-left-style: dashed;
		border-left-color: var(--text-3);
	}
	.around {
		color: var(--text-3);
	}
	.exact {
		background: var(--accent-tint);
		border-radius: 3px;
		padding: 0 2px;
	}
	.orphan .exact {
		background: var(--surface-2);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0 0 17px;
		min-height: 24px;
	}
	.state {
		font-size: 11px;
		font-style: italic;
		color: var(--text-3);
	}
	.spacer {
		flex: 1;
	}
	.rm {
		width: 24px;
		height: 24px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--text-3);
		opacity: 0;
		transition: opacity 120ms ease;
	}
	.ask:hover .rm,
	.rm:focus-visible {
		opacity: 1;
	}
	.rm:hover {
		color: var(--accent-text);
		background: var(--surface-2);
	}
	.ask :global(.well) {
		margin-top: 4px;
	}
</style>
