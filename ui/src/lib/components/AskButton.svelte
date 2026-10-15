<script lang="ts">
	// Floating pill shown above a text selection. Handled on mousedown with
	// preventDefault so the browser keeps the selection until the composer opens.
	let { x, y, onask }: { x: number; y: number; onask: () => void } = $props();
</script>

<button
	type="button"
	class="ibtn primary pill ask"
	data-ask
	style="left:{x}px; top:{y}px"
	onmousedown={(e) => {
		e.preventDefault();
		onask();
	}}
>
	Ask about this
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
</style>
