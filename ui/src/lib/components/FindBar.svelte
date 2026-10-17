<script lang="ts">
	// Find-in-conversation bar, docked under the header. Enter and Shift+Enter
	// step through matches, Escape closes.
	import { find } from '$lib/state/find.svelte';
	import Icon from './Icon.svelte';

	let input: HTMLInputElement | undefined = $state();

	$effect(() => {
		if (find.open) {
			setTimeout(() => {
				input?.focus();
				input?.select();
			}, 0);
		}
	});

	const label = $derived(!find.query.trim() ? '' : find.count ? `${find.current + 1} of ${find.count}` : 'No matches');

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) find.prev();
			else find.next();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			find.hide();
		}
	}
</script>

{#if find.open}
	<div class="findbar" role="search" data-nofind>
		<Icon name="search" size={13} />
		<input bind:this={input} class="q" placeholder="Find in conversation" value={find.query} oninput={(e) => find.setQuery(e.currentTarget.value)} onkeydown={onKey} aria-label="Find in conversation" />
		<span class="status" class:none={find.query.trim() !== '' && !find.count}>{label}</span>
		<button type="button" class="nav" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!find.count} onclick={() => find.prev()}><Icon name="chevron-up" size={13} /></button>
		<button type="button" class="nav" title="Next match (Enter)" aria-label="Next match" disabled={!find.count} onclick={() => find.next()}><Icon name="chevron-down" size={13} /></button>
		<button type="button" class="nav" title="Close (Esc)" aria-label="Close find" onclick={() => find.hide()}><Icon name="x" size={13} /></button>
	</div>
{/if}

<style>
	.findbar {
		position: absolute;
		top: 8px;
		right: 20px;
		z-index: 6;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px 4px 10px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 10px;
		box-shadow: var(--shadow);
		color: var(--text-3);
	}
	.q {
		width: 200px;
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		padding: 3px 4px;
		outline: none;
	}
	.status {
		font-size: 11.5px;
		min-width: 60px;
		text-align: right;
		padding-right: 4px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.status.none {
		color: var(--accent-text);
	}
	.nav {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.nav:hover:not(:disabled) {
		background: var(--surface-2);
		color: var(--text);
	}
	.nav:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
