<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Dropdown under the header's model pill. Picks the model for new turns in
	// the current conversation.
	import type { ModelInfo } from '$lib/api/types';
	import Icon from './Icon.svelte';

	let {
		agentName,
		models,
		selected,
		onselect,
		onclose
	}: {
		agentName: string;
		models: ModelInfo[];
		selected: string;
		onselect: (id: string) => void;
		onclose: () => void;
	} = $props();

	let el: HTMLDivElement | undefined = $state();

	$effect(() => {
		const onDown = (e: MouseEvent) => {
			if (
				el &&
				!el.contains(e.target as Node) &&
				!(e.target as HTMLElement).closest('[data-model-pill]')
			)
				onclose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
		};
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});

	const isSelected = (m: ModelInfo) => (selected ? m.id === selected : m.isDefault);
</script>

<div class="menu" bind:this={el} role="menu">
	<div class="label">Model · {agentName}</div>
	{#if models.length === 0}
		<div class="empty">No models reported. The agent's own default is used.</div>
	{/if}
	{#each models as m (m.id)}
		<button
			type="button"
			class="row"
			class:on={isSelected(m)}
			role="menuitemradio"
			aria-checked={isSelected(m)}
			onclick={() => onselect(m.id)}
		>
			<span class="text">
				<span class="name">{m.name}</span>
				{#if m.note}<span class="note">{m.note}</span>{/if}
			</span>
			{#if isSelected(m)}<span class="check"><Icon name="check" size={14} /></span>{/if}
		</button>
	{/each}
	<div class="foot">Applies to new turns in this conversation.</div>
</div>

<style>
	.menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		width: 260px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 10px;
		box-shadow: var(--shadow);
		padding: 6px;
		z-index: 20;
	}
	.label {
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
		padding: 6px 8px 4px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 7px 8px;
		border-radius: 7px;
		text-align: left;
	}
	.row:hover {
		background: var(--surface);
	}
	.row.on {
		background: var(--surface);
	}
	.text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.name {
		font-size: 13px;
		font-weight: 500;
	}
	.note {
		font-size: 11.5px;
		color: var(--text-3);
	}
	.check {
		color: var(--accent);
		display: inline-flex;
	}
	.foot,
	.empty {
		font-size: 11px;
		color: var(--text-3);
		padding: 6px 8px 4px;
	}
</style>
