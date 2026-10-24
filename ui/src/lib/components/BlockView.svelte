<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Renders one markdown block with its highlight marks, then everything
	// anchored to it: the clarification wells and, while the user is writing a
	// new question, the inline composer. Wells render replies through this same
	// component, so a reply's blocks can carry their own nested wells.
	import type { Conversation } from '$lib/api/types';
	import { resolveMark, segmentRuns, type Mark } from '$lib/markdown/anchor';
	import type { Block } from '$lib/markdown/blocks';
	import { app } from '$lib/state/app.svelte';
	import { blockRegistry, turnOfBlock, type Thread } from '$lib/state/threads';
	import ArtifactCard from './ArtifactCard.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import InlineComposer from './InlineComposer.svelte';
	import Well from './Well.svelte';

	let {
		block,
		conv,
		threads,
		depth = 0,
		parentId = null
	}: {
		block: Block;
		conv: Conversation;
		threads: Map<string, Thread>;
		depth?: number;
		parentId?: string | null;
	} = $props();

	const COMPOSER_MARK = '__composer';

	const anchored = $derived(conv.clarifications.filter((c) => c.anchorBlockId === block.id));
	const composerHere = $derived(app.composerFor?.blockId === block.id ? app.composerFor : null);

	const marks = $derived.by((): Mark[] => {
		if (
			block.kind === 'code' ||
			block.kind === 'table' ||
			block.kind === 'hr' ||
			block.kind === 'artifact'
		)
			return [];
		const out: Mark[] = anchored.map((c) => ({
			start: resolveMark(block.text, c.quote),
			len: c.quote.length,
			id: c.id
		}));
		if (composerHere)
			out.push({
				start: resolveMark(block.text, composerHere.quote),
				len: composerHere.quote.length,
				id: COMPOSER_MARK
			});
		return out;
	});

	const segments = $derived(segmentRuns(block.runs, marks));

	$effect(() => {
		blockRegistry.set(block.id, { text: block.text, parentId, kind: block.kind });
		return () => {
			blockRegistry.delete(block.id);
		};
	});

	function onMark(id: string) {
		if (id === COMPOSER_MARK) return;
		app.toggleClarification(id);
	}

	const tag = $derived(
		block.kind === 'h'
			? `h${Math.min(6, Math.max(1, (block.level ?? 4) + (depth > 0 ? 1 : 0)))}`
			: 'p'
	);
</script>

{#snippet inline()}
	{#each segments as s, i (i)}
		{#if s.markId}
			<span
				class="mark"
				role="button"
				tabindex="0"
				onclick={() => onMark(s.markId!)}
				onkeydown={(e) => e.key === 'Enter' && onMark(s.markId!)}
			>
				{#if s.run.code}<code>{s.t}</code>{:else if s.run.href}<a
						href={s.run.href}
						target="_blank"
						rel="noreferrer"
						class:b={s.run.b}
						class:i={s.run.i}>{s.t}</a
					>{:else}<span class:b={s.run.b} class:i={s.run.i} class:del={s.run.del}>{s.t}</span>{/if}
			</span>
		{:else if s.run.code}
			<code>{s.t}</code>
		{:else if s.run.href}
			<a href={s.run.href} target="_blank" rel="noreferrer" class:b={s.run.b} class:i={s.run.i}
				>{s.t}</a
			>
		{:else if s.run.b || s.run.i || s.run.del}
			<span class:b={s.run.b} class:i={s.run.i} class:del={s.run.del}>{s.t}</span>
		{:else}
			{s.t}
		{/if}
	{/each}
{/snippet}

<div class="blockwrap" class:nested={depth > 0}>
	{#if block.kind === 'artifact' && block.artifact}
		<ArtifactCard artifact={block.artifact} turnId={turnOfBlock(block.id)} />
	{:else if block.kind === 'code'}
		<div data-block={block.id} class="codehost">
			<CodeBlock
				code={block.code ?? ''}
				lang={block.lang ?? ''}
				clarified={anchored.length > 0}
				nested={depth > 0}
			/>
		</div>
	{:else if block.kind === 'hr'}
		<hr />
	{:else if block.kind === 'table'}
		<div class="tablewrap" data-block={block.id}>
			<table>
				<thead>
					<tr
						>{#each block.rows?.[0] ?? [] as cell, ci (ci)}<th
								>{#each cell as r, ri (ri)}{#if r.code}<code>{r.t}</code>{:else}<span
											class:b={r.b}
											class:i={r.i}>{r.t}</span
										>{/if}{/each}</th
							>{/each}</tr
					>
				</thead>
				<tbody>
					{#each (block.rows ?? []).slice(1) as row, rowi (rowi)}
						<tr
							>{#each row as cell, ci (ci)}<td
									>{#each cell as r, ri (ri)}{#if r.code}<code>{r.t}</code>{:else}<span
												class:b={r.b}
												class:i={r.i}>{r.t}</span
											>{/if}{/each}</td
								>{/each}</tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	{:else if block.kind === 'li'}
		<div
			class="li"
			class:ol={block.ordered}
			data-block={block.id}
			style="margin-left:{(block.depth ?? 0) * 22}px"
		>
			{#if block.ordered}<span class="num">{block.num}.</span>{:else}<span class="bullet"
				></span>{/if}
			<span class="litext">{@render inline()}</span>
		</div>
	{:else if block.kind === 'quote'}
		<blockquote data-block={block.id}>{@render inline()}</blockquote>
	{:else}
		<svelte:element
			this={tag}
			class="prose"
			class:h={block.kind === 'h'}
			data-block={block.id}
			style={block.depth ? `margin-left:${block.depth * 22}px` : ''}
			>{@render inline()}</svelte:element
		>
	{/if}

	{#each anchored as cl (cl.id)}
		{@const th = threads.get(cl.id)}
		{#if th}
			<Well thread={th} {conv} {threads} depth={depth + 1} />
		{/if}
	{/each}

	{#if composerHere}
		<InlineComposer
			quote={composerHere.quote}
			nested={depth > 0}
			onsend={(t) => app.ask(t)}
			oncancel={() => (app.composerFor = null)}
		/>
	{/if}
</div>

<style>
	.blockwrap {
		margin: 0 0 10px;
	}
	.blockwrap :global(.well),
	.blockwrap :global(.composer) {
		margin-left: 28px;
	}
	.blockwrap.nested :global(.well),
	.blockwrap.nested :global(.composer) {
		margin-left: 16px;
	}
	.prose {
		margin: 0;
		line-height: 1.6;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.prose.h {
		font-size: 17px;
		font-weight: 600;
		margin: 22px 0 8px;
		line-height: 1.35;
	}
	.nested .prose.h {
		font-size: 14px;
		margin: 12px 0 4px;
	}
	.blockwrap:first-child .prose.h {
		margin-top: 4px;
	}
	.li {
		display: flex;
		gap: 13px;
		align-items: flex-start;
		line-height: 1.6;
	}
	.bullet {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--text-2);
		flex: none;
		margin-top: 0.65em;
		margin-left: 6px;
	}
	.num {
		width: 22px;
		flex: none;
		font-size: 13px;
		color: var(--text-2);
		text-align: right;
		line-height: inherit;
		padding-top: 0.1em;
	}
	.litext {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	blockquote {
		margin: 0;
		padding: 2px 0 2px 12px;
		border-left: 2px solid var(--line);
		color: var(--text-2);
		white-space: pre-wrap;
	}
	hr {
		border: 0;
		border-top: 1px solid var(--line);
		margin: 14px 0;
	}
	code {
		font-family: var(--mono);
		font-size: 0.87em;
		background: var(--surface-2);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.b {
		font-weight: 600;
	}
	.i {
		font-style: italic;
	}
	.del {
		text-decoration: line-through;
	}
	.tablewrap {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		font-size: 0.93em;
	}
	th,
	td {
		border: 1px solid var(--line);
		padding: 5px 10px;
		text-align: left;
		vertical-align: top;
	}
	th {
		background: var(--surface);
		font-weight: 600;
	}
</style>
