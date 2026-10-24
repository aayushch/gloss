<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// A top-level assistant reply: its blocks (with wells under anchored
	// blocks), the pending indicator while streaming, an error banner on
	// failure, and the stubs that list every clarification rooted in it.
	import type { Conversation, Turn } from '$lib/api/types';
	import { parseBlocks } from '$lib/markdown/blocks';
	import { app } from '$lib/state/app.svelte';
	import { relativeTime, rootTurnOf, short, turnsLabel, type Thread } from '$lib/state/threads';
	import ActivityLine from './ActivityLine.svelte';
	import BlockView from './BlockView.svelte';
	import Icon from './Icon.svelte';
	import Pending from './Pending.svelte';
	import RequestCard from './RequestCard.svelte';
	import TurnMeta from './TurnMeta.svelte';

	let {
		turn,
		userTurn,
		conv,
		threads
	}: { turn: Turn; userTurn: Turn | undefined; conv: Conversation; threads: Map<string, Thread> } =
		$props();

	const blocks = $derived(parseBlocks(turn.text, turn.id));
	const running = $derived(turn.status === 'pending' || turn.status === 'streaming');
	const stubs = $derived(
		conv.clarifications.filter((c) => rootTurnOf(c, conv.clarifications) === turn.id)
	);
</script>

<article class="turn" id="turn-{turn.id}">
	{#if !running && turn.text}
		<div class="tools">
			<button
				type="button"
				title="Copy as Markdown, clarifications included"
				aria-label="Copy as Markdown"
				onclick={() => app.copyTurnMarkdown(turn)}><Icon name="copy" size={13} /></button
			>
			<button
				type="button"
				title="Save as Markdown, clarifications included"
				aria-label="Save as Markdown"
				onclick={() => app.saveTurnMarkdown(turn)}><Icon name="download" size={13} /></button
			>
		</div>
	{/if}
	{#each blocks as block (block.id)}
		<BlockView {block} {conv} {threads} depth={0} parentId={null} />
	{/each}

	{#if running}
		{#if app.requests[turn.id]}
			<RequestCard request={app.requests[turn.id]} onanswer={(a) => app.answer(turn.id, a)} />
		{:else}
			{#if !turn.text}<Pending />{/if}
			{#if app.activity[turn.id]}<ActivityLine activity={app.activity[turn.id]} />{/if}
		{/if}
	{:else if turn.status === 'error'}
		<div class="banner">
			<div class="msg">
				<strong>The agent failed.</strong>
				{turn.error ?? 'No details were reported.'}
			</div>
			{#if userTurn}<button type="button" class="ibtn" onclick={() => app.retry(userTurn)}
					>Retry</button
				>{/if}
		</div>
	{:else if turn.status === 'cancelled' && !turn.text}
		<div class="muted">Stopped before a reply arrived.</div>
	{:else}
		<TurnMeta {turn} />
	{/if}

	{#if stubs.length}
		<div class="stubs">
			{#each stubs as cl (cl.id)}
				{@const th = threads.get(cl.id)}
				<button type="button" class="stub" onclick={() => app.jumpTo(cl.id)}>
					<span class="dot"></span>
					<span class="asked">{cl.parentId ? '↳ ' : ''}Asked about “{short(cl.quote, 36)}”</span>
					<span class="meta"
						>{turnsLabel(th?.turns.length ?? 0)} · {relativeTime(cl.createdAt)}</span
					>
					<span class="view">View inline →</span>
				</button>
			{/each}
		</div>
	{/if}
</article>

<style>
	.turn {
		font-size: 15px;
		line-height: 1.6;
		margin-bottom: 26px;
		position: relative;
	}
	.tools {
		position: absolute;
		top: -6px;
		right: 0;
		display: flex;
		gap: 2px;
		opacity: 0;
		transition: opacity 120ms ease;
	}
	.turn:hover .tools,
	.tools:focus-within {
		opacity: 1;
	}
	.tools button {
		width: 26px;
		height: 26px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--text-3);
		background: var(--bg);
	}
	.tools button:hover {
		color: var(--text);
		background: var(--surface-2);
	}
	.banner {
		display: flex;
		align-items: center;
		gap: 12px;
		justify-content: space-between;
		border: 1px solid var(--accent);
		background: var(--accent-tint);
		color: var(--accent-text);
		border-radius: 10px;
		padding: 8px 12px;
		font-size: 13px;
		margin-top: 8px;
	}
	.banner .msg {
		overflow-wrap: anywhere;
	}
	.muted {
		font-size: 13px;
		color: var(--text-3);
		font-style: italic;
	}
	.stubs {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 22px;
	}
	.stub {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		border: 1px dashed var(--line);
		border-radius: 10px;
		padding: 8px 12px;
		font-size: 12px;
		color: var(--text-2);
		text-align: left;
	}
	.stub:hover {
		background: var(--surface);
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
	}
	.asked {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		color: var(--text-3);
		white-space: nowrap;
	}
	.view {
		color: var(--accent-text);
		font-weight: 500;
		white-space: nowrap;
	}
</style>
