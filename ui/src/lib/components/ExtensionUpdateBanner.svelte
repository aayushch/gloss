<script lang="ts">
	// Card at the bottom of the rail shown while a connected browser runs an
	// older extension than the one this Gloss ships. Firefox is updated from
	// the add-on file inside Gloss. Safari loads the new extension from Gloss
	// itself once it restarts. Chromium browsers accept extensions only from
	// the Chrome Web Store, so for them the card says the store update is on
	// its way. Closing the card hides it until the next launch.
	import { app } from '$lib/state/app.svelte';
	import type { SessionInfo } from '$lib/api/types';
	import Icon from './Icon.svelte';

	const ext = $derived(app.extension);
	const outdated = $derived(app.outdatedExtensions);
	const shown = $derived(!!ext && outdated.length > 0 && app.extensionUpdateDismissed !== ext.bundledVersion);

	function browserName(s: SessionInfo): string {
		if (s.browser === 'chrome') return 'Chrome';
		return s.browser ? s.browser.charAt(0).toUpperCase() + s.browser.slice(1) : 'Browser';
	}
</script>

{#if shown && ext}
	<div class="banner" role="status">
		<div class="line">
			<span class="mark"><Icon name="globe" size={13} /></span>
			<span class="text">Extension update {ext.bundledVersion}</span>
			<button type="button" class="close" title="Dismiss until Gloss restarts" aria-label="Dismiss extension update notice" onclick={() => app.dismissExtensionUpdate()}><Icon name="x" size={12} /></button>
		</div>
		{#each outdated as s (s.browser)}
			<div class="item">
				<span class="what">{browserName(s)} runs {s.extensionVersion}.</span>
				{#if s.browser === 'firefox'}
					{#if !ext.xpiBundled}
						<span class="how">This build of Gloss does not carry the Firefox add-on.</span>
					{:else if app.firefoxUpdateStarted}
						<span class="how">Confirm the update in Firefox. This card goes away once Firefox reconnects with {ext.bundledVersion}.</span>
					{:else}
						<button type="button" class="act" onclick={() => app.updateFirefoxExtension()}>Update Firefox extension</button>
					{/if}
				{:else if s.browser === 'safari'}
					<span class="how">Quit and reopen Safari to load {ext.bundledVersion} from Gloss.</span>
				{:else}
					<span class="how">Chromium browsers take extensions from the Chrome Web Store only; {browserName(s)} installs {ext.bundledVersion} from there by itself, usually within a few hours.</span>
				{/if}
			</div>
		{/each}
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
	.item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		font-size: 11.5px;
		line-height: 1.4;
	}
	.what {
		color: var(--text);
	}
	.how {
		color: var(--text-2);
	}
	.act {
		padding: 4px 9px;
		border-radius: 6px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 11.5px;
		font-weight: 500;
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
