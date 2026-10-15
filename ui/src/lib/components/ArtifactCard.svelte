<script lang="ts">
	// The card a reply shows where an artifact was written. Clicking it opens
	// that version in the artifact pane.
	import { artifactTypeLabel, type Artifact } from '$lib/markdown/artifacts';
	import { app } from '$lib/state/app.svelte';
	import Icon from './Icon.svelte';

	let { artifact, turnId }: { artifact: Artifact; turnId: string } = $props();

	const version = $derived(app.artifacts.find((g) => g.identifier === artifact.identifier)?.versions.find((v) => v.turnId === turnId));
	const total = $derived(app.artifacts.find((g) => g.identifier === artifact.identifier)?.versions.length ?? 1);
	const active = $derived(app.isViewing(artifact.identifier, turnId));
</script>

<button type="button" class="card" class:active onclick={() => app.openArtifact(artifact.identifier, turnId)}>
	<span class="glyph"><Icon name="artifact" size={18} /></span>
	<span class="body">
		<span class="title">{artifact.title}</span>
		<span class="meta">
			{artifactTypeLabel(artifact)}
			{#if total > 1 && version}<span class="sep">·</span>v{version.version} of {total}{/if}
			{#if !artifact.complete}<span class="sep">·</span><span class="writing">Writing…</span>{/if}
		</span>
	</span>
	<span class="open">{active ? 'Open' : 'View'}</span>
</button>

<style>
	.card {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		max-width: 420px;
		margin: 8px 0;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface);
		text-align: left;
		color: var(--text);
		font: inherit;
		cursor: pointer;
		transition: border-color 120ms ease, background 120ms ease;
	}
	.card:hover {
		background: var(--surface-2);
	}
	.card.active {
		border-color: var(--accent);
	}
	.glyph {
		width: 36px;
		height: 36px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		background: var(--bg);
		color: var(--accent-text);
	}
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.title {
		font-size: 14px;
		font-weight: 500;
		line-height: 1.3;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: 12px;
		color: var(--text-3);
	}
	.sep {
		margin: 0 5px;
	}
	.writing {
		color: var(--accent-text);
	}
	.open {
		font-size: 12px;
		color: var(--accent-text);
		font-weight: 500;
		white-space: nowrap;
	}
</style>
