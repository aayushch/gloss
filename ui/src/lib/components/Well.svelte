<script lang="ts">
	// A clarification thread rendered under the block it is anchored to. The
	// header toggles collapse; each row pairs the question with its reply, and
	// the reply goes through BlockView so it can host nested wells.
	import type { Conversation, Turn } from '$lib/api/types';
	import { parseBlocks } from '$lib/markdown/blocks';
	import { app } from '$lib/state/app.svelte';
	import { pad, short, turnsLabel, type Thread } from '$lib/state/threads';
	import ActivityLine from './ActivityLine.svelte';
	import BlockView from './BlockView.svelte';
	import Icon from './Icon.svelte';
	import Pending from './Pending.svelte';
	import RequestCard from './RequestCard.svelte';
	import TurnMeta from './TurnMeta.svelte';

	let { thread, conv, threads, depth = 1 }: { thread: Thread; conv: Conversation; threads: Map<string, Thread>; depth?: number } = $props();

	const cl = $derived(thread.clarification);
	const number = $derived(conv.clarifications.findIndex((c) => c.id === cl.id) + 1);
	let follow = $state('');

	function isRunning(t: Turn | undefined) {
		return !!t && (t.status === 'pending' || t.status === 'streaming');
	}

	function sendFollow() {
		const q = follow.trim();
		if (!q) return;
		follow = '';
		app.followUp(cl.id, q);
	}
</script>

<section class="well" class:deep={depth > 1} id="well-{cl.id}">
	<button type="button" class="head" onclick={() => app.toggleClarification(cl.id)} aria-expanded={cl.open}>
		<span class="dot"></span>
		<span class="label">Clarification {pad(number)}</span>
		<span class="re">re “{short(cl.quote)}”</span>
		<span class="count">{turnsLabel(thread.turns.length)}</span>
		<span class="chev" class:open={cl.open}><Icon name="chevron-down" size={14} /></span>
	</button>

	{#if cl.open}
		{#each thread.turns as row (row.question.id)}
			<div class="row" id="turn-{row.question.id}">
				<span class="col you">You</span>
				<div class="q">{row.question.text}</div>
				<span class="col reply">Reply</span>
				<div class="a" id={row.reply ? `turn-${row.reply.id}` : undefined}>
					{#if row.reply}
						{#if row.reply.status === 'error'}
							<div class="err">
								<span>{row.reply.error ?? 'The agent failed to answer.'}</span>
								<button type="button" class="ibtn ghost" onclick={() => app.retry(row.question)}>Retry</button>
							</div>
						{:else if row.reply.status === 'cancelled' && !row.reply.text}
							<div class="muted">Stopped before a reply arrived.</div>
						{/if}
						{#each parseBlocks(row.reply.text, row.reply.id) as block (block.id)}
							<BlockView {block} {conv} {threads} {depth} parentId={cl.id} />
						{/each}
						{#if isRunning(row.reply)}
							{#if app.requests[row.reply.id]}
								<RequestCard request={app.requests[row.reply.id]} onanswer={(a) => app.answer(row.reply!.id, a)} />
							{:else}
								{#if !row.reply.text}<Pending />{/if}
								{#if app.activity[row.reply.id]}<ActivityLine activity={app.activity[row.reply.id]} />{/if}
							{/if}
						{:else}
							<TurnMeta turn={row.reply} />
						{/if}
					{:else}
						<Pending />
					{/if}
				</div>
			</div>
		{/each}
		<div class="follow">
			<input
				class="iinput"
				placeholder="Follow up in this clarification…"
				bind:value={follow}
				disabled={app.running}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						sendFollow();
					}
				}}
			/>
			<button type="button" class="ibtn ghost" onclick={sendFollow} disabled={app.running || !follow.trim()}>Ask</button>
		</div>
	{/if}
</section>

<style>
	.well {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 10px;
		font-size: 13px;
		overflow: hidden;
		margin: 8px 0 20px;
	}
	.well.deep {
		background: var(--bg);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent-text);
		text-align: left;
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
	}
	.label {
		flex: none;
	}
	.re {
		flex: 1;
		min-width: 0;
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-3);
		flex: none;
	}
	.chev {
		display: inline-flex;
		color: var(--text-3);
		transition: transform 0.15s;
		flex: none;
	}
	.chev.open {
		transform: rotate(180deg);
	}
	.row {
		border-top: 1px solid var(--line);
		padding: 9px 12px;
		display: grid;
		grid-template-columns: 40px 1fr;
		gap: 4px 10px;
	}
	.col {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding-top: 3px;
	}
	.you {
		color: var(--text-3);
	}
	.reply {
		color: var(--accent-text);
	}
	.q {
		font-size: 13px;
		font-weight: 500;
		color: var(--text);
		white-space: pre-wrap;
	}
	.a {
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-2);
		min-width: 0;
	}
	.a :global(.blockwrap) {
		margin-bottom: 8px;
	}
	.a :global(.blockwrap:last-child) {
		margin-bottom: 0;
	}
	.err {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--accent-text);
		margin-bottom: 6px;
	}
	.muted {
		color: var(--text-3);
		font-style: italic;
	}
	.follow {
		border-top: 1px solid var(--line);
		padding: 6px 12px 8px 62px;
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.follow .iinput {
		height: 28px;
		font-size: 12px;
		padding: 0 10px;
	}
</style>
