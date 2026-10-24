<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Floating pill shown above a text selection. Handled on mousedown with
	// preventDefault so the browser keeps the selection until the composer
	// opens. While a reply is running the pill is inert and says so: the
	// engine takes one turn per conversation at a time, so a clarification
	// sent now would be refused.
	let {
		x,
		y,
		disabled = false,
		onask
	}: { x: number; y: number; disabled?: boolean; onask: () => void } = $props();
</script>

<button
	type="button"
	class="ibtn pill ask"
	class:primary={!disabled}
	class:off={disabled}
	data-ask
	aria-disabled={disabled}
	style="left:{x}px; top:{y}px"
	onmousedown={(e) => {
		e.preventDefault();
		if (!disabled) onask();
	}}
>
	Ask about this
	{#if disabled}
		<span class="note">wait for the reply to finish</span>
	{/if}
</button>

<style>
	.ask {
		position: absolute;
		transform: translateX(-50%);
		box-shadow: var(--shadow);
		font-size: 13px;
		padding: 6px 12px;
		z-index: 5;
	}
	.off {
		flex-direction: column;
		gap: 1px;
		background: var(--surface);
		color: var(--text-2);
		cursor: not-allowed;
	}
	.off:hover {
		background: var(--surface);
	}
	.note {
		font-size: 11px;
		font-weight: 400;
		color: var(--text-3);
		white-space: nowrap;
	}
</style>
