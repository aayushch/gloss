<script lang="ts">
	import type { UiStore } from './store.svelte';
	import type { Actions } from './actions';
	import Pill from './Pill.svelte';
	import Composer from './Composer.svelte';
	import Popover from './Popover.svelte';

	let { store, actions }: { store: UiStore; actions: Actions } = $props();
	const running = $derived.by(() => {
		store.version;
		return store.page.running;
	});
</script>

{#if store.pill && !store.composer}
	<Pill pill={store.pill} inert={running} onopen={actions.openComposer} />
{/if}
{#if store.composer}
	<Composer composer={store.composer} connection={store.connection} {running} {actions} />
{/if}
{#if store.popover}
	<Popover {store} {actions} />
{/if}
{#if store.toast}
	<div class="gloss-toast" role="status">{store.toast}</div>
{/if}
