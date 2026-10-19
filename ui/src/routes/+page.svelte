<script lang="ts">
	import { onMount } from 'svelte';
	import { app } from '$lib/state/app.svelte';
	import { find } from '$lib/state/find.svelte';
	import { updater } from '$lib/state/updater.svelte';
	import ArtifactPane from '$lib/components/ArtifactPane.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import FindBar from '$lib/components/FindBar.svelte';
	import Header from '$lib/components/Header.svelte';
	import Rail from '$lib/components/Rail.svelte';
	import SettingsSheet from '$lib/components/SettingsSheet.svelte';
	import Transcript from '$lib/components/Transcript.svelte';

	onMount(() => {
		app.init();
		updater.start();
		return () => updater.stop();
	});

	// Cmd/Ctrl+F opens find in the conversation, seeded with any text selected
	// in the transcript; Cmd/Ctrl+G and Shift step through matches.
	function onKey(e: KeyboardEvent) {
		const mod = e.metaKey || e.ctrlKey;
		if (!mod || e.altKey) return;
		if (e.key === 'f' || e.key === 'F') {
			if (!app.active) return;
			e.preventDefault();
			const sel = window.getSelection();
			const selected = sel && !sel.isCollapsed && sel.anchorNode && document.querySelector('.transcript')?.contains(sel.anchorNode) ? sel.toString().trim() : '';
			find.show(selected && !selected.includes('\n') ? selected : undefined);
		} else if ((e.key === 'g' || e.key === 'G') && find.open) {
			e.preventDefault();
			if (e.shiftKey) find.prev();
			else find.next();
		}
	}

	const composerDisabled = $derived.by(() => {
		if (app.loadError) return true;
		const agent = app.activeAgent;
		return (!!app.draft || !!app.viewing) && (!agent || !agent.available);
	});
</script>

<svelte:window onkeydown={onKey} onfocus={() => app.refreshOutside()} />

<div class="shell">
	<Rail />
	<main class="conversation">
		<Header />
		<div class="body">
			<FindBar />
			<Transcript />
		</div>
		<Composer disabled={composerDisabled} running={app.running} onsend={(t) => app.send(t)} onstop={() => app.cancel()} />
	</main>
	{#if app.viewedArtifact}
		<ArtifactPane artifact={app.viewedArtifact} group={app.viewedGroup} />
	{/if}
</div>

{#if app.settingsOpen}
	<SettingsSheet />
{/if}
{#if app.notice}
	<div class="notice" role="status">{app.notice}</div>
{/if}

<style>
	.shell {
		display: flex;
		height: 100vh;
		width: 100vw;
		background: var(--bg);
		color: var(--text);
	}
	:global([data-platform='macos']) .shell {
		border-top: 1px solid var(--line);
	}
	.conversation {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	/* Hosts the transcript and the find bar floating over its top edge. */
	.body {
		flex: 1;
		min-height: 0;
		position: relative;
		display: flex;
		flex-direction: column;
	}
	.notice {
		position: fixed;
		bottom: 72px;
		left: 50%;
		transform: translateX(-50%);
		background: var(--text);
		color: var(--bg);
		font-size: 12.5px;
		padding: 7px 14px;
		border-radius: 999px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
		z-index: 30;
		max-width: 70vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
