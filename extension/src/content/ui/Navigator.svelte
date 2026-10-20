<script lang="ts">
	// The note navigator: a small bar docked on the right edge that steps
	// through the page's notes in reading order. The middle button shows
	// the current note's position ("2/5"), or the note count before any
	// note was shown, and opens or closes that note. Dragging the bar moves
	// it up or down the edge; where it docks is worked out by `Dock` in
	// dock.ts.
	import { innerHeight } from 'svelte/reactivity/window';
	import { MARK_SVG } from '../../shared/mark';
	import { NAV_HEIGHT } from '../dock';
	import { orderedAskIds } from '../state';
	import type { Actions } from './actions';
	import type { UiStore } from './store.svelte';

	let { store, actions, dock }: { store: UiStore; actions: Actions; dock: { left: number; top: number } } = $props();

	/** A press moves the bar only after the pointer travels this far, so plain clicks still click. */
	const DRAG_THRESHOLD = 4;
	const EDGE = 16;

	const ids = $derived.by(() => {
		store.version;
		return orderedAskIds(store.page);
	});
	const current = $derived(store.popover?.askId ?? store.lastAskId);
	const index = $derived(current ? ids.indexOf(current) : -1);
	const label = $derived(index >= 0 ? `${index + 1}/${ids.length}` : String(ids.length));
	const title = $derived.by(() => {
		const notes = `${ids.length} ${ids.length === 1 ? 'note' : 'notes'} on this page`;
		if (store.popover) return `${notes}. Close this note`;
		return index >= 0 ? `${notes}. Show note ${index + 1}` : `${notes}. Show the first`;
	});

	/** The bar's top while it is being dragged; null otherwise. */
	let dragTop = $state<number | null>(null);
	let press: { startY: number; startTop: number; moved: boolean } | null = null;
	/** Set when a drag ends, so the click that follows the release does not also press a button. */
	let swallowClick = false;
	const top = $derived(dragTop ?? dock.top);

	function onpointerdown(e: PointerEvent) {
		if (e.button !== 0 || (e.target as Element).closest('.gloss-nav-hide')) return;
		press = { startY: e.clientY, startTop: dock.top, moved: false };
		window.addEventListener('pointermove', onpointermove, true);
		// Releases over the page reach the window; releases over the bar
		// are kept from the page and arrive at the bar's own handler.
		window.addEventListener('pointerup', onpointerup, true);
		window.addEventListener('pointercancel', onpointerup, true);
	}

	function onpointermove(e: PointerEvent) {
		if (!press) return;
		const dy = e.clientY - press.startY;
		if (!press.moved && Math.abs(dy) < DRAG_THRESHOLD) return;
		press.moved = true;
		const max = (innerHeight.current ?? 768) - NAV_HEIGHT - EDGE;
		dragTop = Math.min(max, Math.max(EDGE, press.startTop + dy));
	}

	function onpointerup() {
		window.removeEventListener('pointermove', onpointermove, true);
		window.removeEventListener('pointerup', onpointerup, true);
		window.removeEventListener('pointercancel', onpointerup, true);
		if (press?.moved && dragTop !== null) {
			actions.moveNavigator(dragTop);
			swallowClick = true;
			setTimeout(() => (swallowClick = false), 0);
		}
		press = null;
		dragTop = null;
	}

	function onclickcapture(e: MouseEvent) {
		if (!swallowClick) return;
		swallowClick = false;
		e.stopPropagation();
		e.preventDefault();
	}
</script>

<div
	class="gloss-nav"
	class:is-engaged={!!store.popover}
	class:is-dragging={dragTop !== null}
	style="left:{Math.round(dock.left)}px; top:{Math.round(top)}px"
	role="toolbar"
	aria-label="Gloss notes on this page"
	tabindex="-1"
	{onpointerdown}
	{onpointerup}
	{onclickcapture}
>
	<button type="button" class="gloss-nav-step" title="Previous note" aria-label="Previous note" disabled={ids.length < 2 && index >= 0} onclick={() => actions.stepNote(-1)}>‹</button>
	<button type="button" class="gloss-nav-current" title="{title}. Drag to move up or down." aria-label={title} aria-pressed={!!store.popover} onclick={() => actions.toggleNote()}>
		<span class="gloss-nav-mark">{@html MARK_SVG}</span>
		<span class="gloss-nav-count">{label}</span>
	</button>
	<button type="button" class="gloss-nav-step" title="Next note" aria-label="Next note" disabled={ids.length < 2 && index >= 0} onclick={() => actions.stepNote(1)}>›</button>
	<button type="button" class="gloss-nav-hide" title="Hide on this page. The Gloss toolbar button can show it again." aria-label="Hide the note navigator" onclick={() => actions.hideNavigator()}>×</button>
</div>
