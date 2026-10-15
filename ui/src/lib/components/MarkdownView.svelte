<script lang="ts">
	// Read-only markdown rendering for the artifact pane. It uses the same
	// block parser as the transcript but attaches nothing to the blocks: no
	// marks, no wells, no "ask about this".
	import { parseBlocks, type Run } from '$lib/markdown/blocks';
	import CodeBlock from './CodeBlock.svelte';

	let { text }: { text: string } = $props();
	const blocks = $derived(parseBlocks(text, 'artifact'));
</script>

{#snippet runs(list: Run[])}
	{#each list as r, i (i)}
		{#if r.code}<code>{r.t}</code>{:else if r.href}<a href={r.href} target="_blank" rel="noreferrer">{r.t}</a>{:else}<span class:b={r.b} class:i={r.i} class:del={r.del}>{r.t}</span>{/if}
	{/each}
{/snippet}

<div class="md">
	{#each blocks as block (block.id)}
		{#if block.kind === 'h'}
			<svelte:element this={`h${Math.min(6, block.level ?? 1)}`}>{@render runs(block.runs)}</svelte:element>
		{:else if block.kind === 'code'}
			<CodeBlock code={block.code ?? ''} lang={block.lang ?? ''} />
		{:else if block.kind === 'li'}
			<div class="li" style="margin-left:{(block.depth ?? 0) * 22}px">
				{#if block.ordered}<span class="num">{block.num}.</span>{:else}<span class="bullet"></span>{/if}
				<span class="litext">{@render runs(block.runs)}</span>
			</div>
		{:else if block.kind === 'quote'}
			<blockquote>{@render runs(block.runs)}</blockquote>
		{:else if block.kind === 'hr'}
			<hr />
		{:else if block.kind === 'table'}
			<div class="tablewrap">
				<table>
					<thead><tr>{#each block.rows?.[0] ?? [] as cell, ci (ci)}<th>{@render runs(cell)}</th>{/each}</tr></thead>
					<tbody>
						{#each (block.rows ?? []).slice(1) as row, ri (ri)}<tr>{#each row as cell, ci (ci)}<td>{@render runs(cell)}</td>{/each}</tr>{/each}
					</tbody>
				</table>
			</div>
		{:else if block.kind === 'artifact'}
			<pre class="raw">{block.artifact?.content}</pre>
		{:else}
			<p style={block.depth ? `margin-left:${block.depth * 22}px` : ''}>{@render runs(block.runs)}</p>
		{/if}
	{/each}
</div>

<style>
	.md {
		font-size: 15px;
		line-height: 1.6;
		max-width: 720px;
	}
	h1,
	h2,
	h3,
	h4,
	h5,
	h6 {
		font-weight: 600;
		line-height: 1.3;
		margin: 22px 0 8px;
	}
	h1 {
		font-size: 24px;
	}
	h2 {
		font-size: 19px;
	}
	h3 {
		font-size: 16px;
	}
	.md > :first-child {
		margin-top: 0;
	}
	p {
		margin: 0 0 10px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.li {
		display: flex;
		gap: 13px;
		align-items: flex-start;
		margin-bottom: 4px;
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
		padding-top: 0.1em;
	}
	.litext {
		flex: 1;
		min-width: 0;
		white-space: pre-wrap;
	}
	blockquote {
		margin: 0 0 10px;
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
	.raw {
		font-family: var(--mono);
		font-size: 12.5px;
		white-space: pre-wrap;
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
		margin-bottom: 10px;
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
