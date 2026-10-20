<script lang="ts">
	import { innerWidth, innerHeight } from 'svelte/reactivity/window';
	import type { PillState } from './store.svelte';

	let { pill, inert, onopen }: { pill: PillState; inert: boolean; onopen: () => void } = $props();

	const WIDTH = 124;
	const HEIGHT = 30;
	const style = $derived.by(() => {
		const vw = innerWidth.current ?? 1024;
		const vh = innerHeight.current ?? 768;
		const left = Math.min(Math.max(8, pill.x - WIDTH / 2), vw - WIDTH - 8);
		let top = pill.y + 8;
		if (top + HEIGHT > vh - 8) top = Math.max(8, pill.y - HEIGHT - 8);
		return `left:${Math.round(left)}px; top:${Math.round(top)}px`;
	});
</script>

<button
	type="button"
	class="gloss-pill"
	class:is-inert={inert}
	{style}
	title={inert ? 'Wait for the current reply to finish' : 'Ask Gloss about the selection (Alt+Shift+G)'}
	onmousedown={(e) => {
		// Opens on press rather than click: Safari collapses the page
		// selection on the press even though the default is prevented, and
		// the pill is gone before a click could arrive.
		e.preventDefault();
		if (!inert) onopen();
	}}
	onclick={(e) => e.preventDefault()}
>
	<span class="gloss-pill-mark">“</span>
	{inert ? 'Wait for the reply' : 'Ask about this'}
</button>
