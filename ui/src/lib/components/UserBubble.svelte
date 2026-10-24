<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// The user's message, right-aligned, with the files sent alongside it:
	// image attachments as thumbnails, text files as named chips.
	import type { Turn } from '$lib/api/types';
	import { app, formatSize } from '$lib/state/app.svelte';
	import Icon from './Icon.svelte';

	let { turn }: { turn: Turn } = $props();
</script>

<div class="row" id="turn-{turn.id}">
	<div class="bubble">
		{#if turn.attachments.length}
			<div class="files">
				{#each turn.attachments as att (att.id)}
					{#if att.kind === 'image' && app.thumbs[att.id]}
						<img class="thumb" src={app.thumbs[att.id]} alt={att.name} title={att.name} />
					{:else}
						<span class="chip" title="{att.name} · {formatSize(att.size)}"
							><Icon name="file" size={12} />{att.name}</span
						>
					{/if}
				{/each}
			</div>
		{/if}
		<div class="text">{turn.text}</div>
	</div>
</div>

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
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.files {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 8px;
	}
	.thumb {
		max-height: 140px;
		max-width: 100%;
		border-radius: 8px;
		border: 1px solid var(--line);
		display: block;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border-radius: 6px;
		background: var(--surface-2);
		font-size: 12px;
		color: var(--text-2);
		max-width: 260px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
