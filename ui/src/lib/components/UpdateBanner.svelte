<script lang="ts">
	// Small card at the bottom of the rail that offers a newer Gloss, shows the
	// download, and asks for a restart once it is installed. Hidden until a
	// check finds something, and after the user closes it.
	import { updater } from '$lib/state/updater.svelte';
	import Icon from './Icon.svelte';

	const shown = $derived(!updater.dismissed && (updater.status === 'available' || updater.status === 'downloading' || updater.status === 'ready' || (updater.status === 'error' && updater.version !== null)));
</script>

{#if shown}
	<div class="banner" role="status">
		<div class="line">
			{#if updater.status === 'ready'}
				<span class="text">Update ready</span>
				<button type="button" class="act" onclick={() => updater.relaunch()}>Restart</button>
			{:else if updater.status === 'downloading'}
				<span class="text">Downloading {updater.progress}%</span>
			{:else if updater.status === 'error'}
				<span class="text err" title={updater.error ?? ''}>Update failed</span>
				<button type="button" class="act" onclick={() => updater.install()}>Retry</button>
			{:else}
				<span class="text">Gloss {updater.version} available</span>
				<button type="button" class="act" onclick={() => updater.install()}>Update</button>
			{/if}
			<button type="button" class="close" title="Dismiss" aria-label="Dismiss update notice" onclick={() => (updater.dismissed = true)}><Icon name="x" size={12} /></button>
		</div>
		{#if updater.status === 'downloading'}
			<div class="bar"><div class="fill" style="width: {updater.progress}%"></div></div>
		{/if}
	</div>
{/if}

<style>
	.banner {
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--accent-tint);
		padding: 8px 8px 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.text {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.text.err {
		color: var(--text-2);
	}
	.act {
		padding: 3px 9px;
		border-radius: 6px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 11.5px;
		font-weight: 500;
		flex: none;
	}
	.close {
		width: 22px;
		height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--text-3);
		flex: none;
	}
	.close:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.bar {
		height: 3px;
		border-radius: 2px;
		background: var(--surface-2);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.2s;
	}
</style>
