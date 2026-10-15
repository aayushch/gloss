<script lang="ts">
	import { onMount } from 'svelte';
	import { app } from '$lib/state/app.svelte';
	import ArtifactPane from '$lib/components/ArtifactPane.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import Header from '$lib/components/Header.svelte';
	import Rail from '$lib/components/Rail.svelte';
	import SettingsSheet from '$lib/components/SettingsSheet.svelte';
	import Transcript from '$lib/components/Transcript.svelte';

	onMount(() => {
		app.init();
	});

	const composerDisabled = $derived.by(() => {
		if (app.loadError) return true;
		const agent = app.activeAgent;
		return !!app.draft && (!agent || !agent.available);
	});
</script>

<div class="shell">
	<Rail />
	<main class="conversation">
		<Header />
		<Transcript />
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
	.conversation {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		height: 100%;
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
