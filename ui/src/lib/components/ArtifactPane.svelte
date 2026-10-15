<script lang="ts">
	// The artifact pane: title and type, version stepper, Preview and Code
	// tabs, and the copy, save and open actions. The preview's script and
	// network switches reset whenever a different artifact opens.
	import { artifactLang, artifactTypeLabel, canPreview, type ArtifactGroup, type ArtifactVersion } from '$lib/markdown/artifacts';
	import { app } from '$lib/state/app.svelte';
	import ArtifactPreview from './ArtifactPreview.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import Icon from './Icon.svelte';

	let { artifact, group }: { artifact: ArtifactVersion; group: ArtifactGroup | undefined } = $props();

	let tab = $state<'preview' | 'code'>('preview');
	let scripts = $state(false);
	let network = $state(false);
	let shownFor = $state('');

	const previewable = $derived(canPreview(artifact) && artifact.complete);
	const total = $derived(group?.versions.length ?? 1);

	// A new artifact resets the switches and lands on the preview when it has one.
	$effect(() => {
		if (shownFor === artifact.identifier) return;
		shownFor = artifact.identifier;
		scripts = false;
		network = false;
		tab = 'preview';
	});

	const showPreview = $derived(tab === 'preview' && previewable);
</script>

<aside class="pane" aria-label="Artifact">
	<div class="head">
		<div class="titles">
			<div class="title" title={artifact.title}>{artifact.title}</div>
			<div class="sub">
				{artifactTypeLabel(artifact)}
				{#if !artifact.complete}<span class="writing"> · Writing…</span>{/if}
			</div>
		</div>
		{#if total > 1}
			<div class="versions">
				<button type="button" class="ico" disabled={artifact.version <= 1} aria-label="Previous version" onclick={() => app.showArtifactVersion(artifact.version - 1)}><Icon name="chevron-left" size={14} /></button>
				<span>v{artifact.version} of {total}</span>
				<button type="button" class="ico" disabled={artifact.version >= total} aria-label="Next version" onclick={() => app.showArtifactVersion(artifact.version + 1)}><Icon name="chevron-right" size={14} /></button>
			</div>
		{/if}
		<button type="button" class="ico" title="Close" aria-label="Close artifact" onclick={() => app.closeArtifact()}><Icon name="x" size={15} /></button>
	</div>
	<div class="bar">
		<div class="tabs" role="tablist">
			<button type="button" role="tab" class:on={showPreview} disabled={!previewable} aria-selected={showPreview} onclick={() => (tab = 'preview')}><Icon name="eye" size={13} />Preview</button>
			<button type="button" role="tab" class:on={!showPreview} aria-selected={!showPreview} onclick={() => (tab = 'code')}><Icon name="code" size={13} />Code</button>
		</div>
		{#if showPreview && artifact.type === 'html'}
			<div class="switches">
				<label title="Let scripts in the page run. The page stays isolated from Gloss."><input type="checkbox" bind:checked={scripts} />Scripts</label>
				<label title="Let the page load from the internet (fonts, libraries, images)."><input type="checkbox" bind:checked={network} />Network</label>
			</div>
		{/if}
		<div class="actions">
			<button type="button" class="act" title="Copy content" onclick={() => app.copyArtifact(artifact)}><Icon name="copy" size={13} />Copy</button>
			<button type="button" class="act" title="Save to a file" onclick={() => app.saveArtifact(artifact)}><Icon name="download" size={13} />Save…</button>
			<button type="button" class="act" title={artifact.type === 'html' ? 'Open in the browser' : 'Open with the default app'} onclick={() => app.openArtifactExternally(artifact)}><Icon name="external" size={13} />Open</button>
		</div>
	</div>
	<div class="body" class:code={!showPreview}>
		{#if showPreview}
			<ArtifactPreview {artifact} {scripts} {network} />
		{:else}
			<CodeBlock code={artifact.content} lang={artifactLang(artifact)} />
		{/if}
	</div>
</aside>

<style>
	.pane {
		width: clamp(360px, 46%, 760px);
		flex: none;
		display: flex;
		flex-direction: column;
		height: 100%;
		border-left: 1px solid var(--line);
		background: var(--bg);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 14px 8px 18px;
	}
	.titles {
		flex: 1;
		min-width: 0;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: 12px;
		color: var(--text-3);
	}
	.writing {
		color: var(--accent-text);
	}
	.versions {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 12px;
		color: var(--text-2);
		white-space: nowrap;
	}
	.ico {
		width: 26px;
		height: 26px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--text-3);
		background: transparent;
	}
	.ico:hover:not(:disabled) {
		color: var(--text);
		background: var(--surface-2);
	}
	.ico:disabled {
		opacity: 0.35;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 14px 8px 18px;
		border-bottom: 1px solid var(--line);
		font-size: 12px;
	}
	.tabs {
		display: inline-flex;
		background: var(--surface);
		border-radius: 7px;
		padding: 2px;
	}
	.tabs button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border-radius: 5px;
		color: var(--text-2);
		font-size: 12px;
	}
	.tabs button.on {
		background: var(--bg);
		color: var(--text);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}
	.tabs button:disabled {
		opacity: 0.4;
	}
	.switches {
		display: inline-flex;
		gap: 10px;
		color: var(--text-2);
	}
	.switches label {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}
	.switches input {
		margin: 0;
	}
	.actions {
		margin-left: auto;
		display: inline-flex;
		gap: 2px;
	}
	.act {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 7px;
		border-radius: 6px;
		color: var(--text-2);
		font-size: 12px;
	}
	.act:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.body {
		flex: 1;
		min-height: 0;
	}
	.body.code {
		overflow: auto;
		padding: 12px 18px;
	}
	.body.code :global(.code) {
		margin: 0;
	}
</style>
