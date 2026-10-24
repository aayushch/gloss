<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { UiStore } from './store.svelte';
	import type { Actions } from './actions';
	import Pill from './Pill.svelte';
	import Composer from './Composer.svelte';
	import Popover from './Popover.svelte';
	import Navigator from './Navigator.svelte';

	let { store, actions }: { store: UiStore; actions: Actions } = $props();
	const running = $derived.by(() => {
		store.version;
		return store.page.running;
	});
</script>

<!-- The navigator comes first so the pill, composer and popover paint over it. -->
{#if store.dock}
	<Navigator {store} {actions} dock={store.dock} />
{/if}
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
