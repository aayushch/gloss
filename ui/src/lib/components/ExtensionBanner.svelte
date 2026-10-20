<script lang="ts">
	// Small card at the bottom of the rail that invites installing the browser
	// extension. Shown until the user dismisses it; the dismissal is kept in
	// the settings so it stays dismissed across launches.
	import { app } from '$lib/state/app.svelte';
	import Icon from './Icon.svelte';
</script>

{#if !app.settings.extensionBannerSeen}
	<div class="banner" role="status">
		<div class="line">
			<span class="mark"><Icon name="globe" size={13} /></span>
			<span class="text">Ask about any web page</span>
			<button type="button" class="close" title="Dismiss" aria-label="Dismiss extension notice" onclick={() => app.dismissExtensionBanner()}><Icon name="x" size={12} /></button>
		</div>
		<button type="button" class="act" onclick={() => { app.settingsTab = 'extension'; app.settingsOpen = true; }}>Install the Gloss extension</button>
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
	.mark {
		display: inline-flex;
		color: var(--accent-text);
		flex: none;
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
	.act {
		padding: 4px 9px;
		border-radius: 6px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 11.5px;
		font-weight: 500;
		align-self: flex-start;
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
</style>
