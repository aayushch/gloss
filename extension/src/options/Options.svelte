<script lang="ts">
	// The options page. Every setting lives in Gloss itself; this page
	// explains where to find them and what the extension sends.
	import { onDestroy, onMount } from 'svelte';
	import { connectClient, type Client } from '../shared/client';
	import { MARK_SVG } from '../shared/mark';
	import type { ConnectionStatus } from '../shared/messages';
	import { DEFAULT_SETTINGS } from '../shared/protocol';

	let client: Client;
	let status = $state<ConnectionStatus>({ state: 'connecting', settings: DEFAULT_SETTINGS });

	onMount(async () => {
		client = connectClient();
		client.onEvent((event, data) => {
			if (event === 'connection') status = data as ConnectionStatus;
		});
		status = await client.status();
	});
	onDestroy(() => client?.close());

	function openGloss() {
		client.request('launchApp', {}).catch(() => {});
	}

	const shortcutsPage = __BROWSER__ === 'firefox' ? 'about:addons, then Manage Extension Shortcuts' : __BROWSER__ === 'safari' ? 'Safari › Settings › Extensions' : 'chrome://extensions/shortcuts';
</script>

<div class="page" style="max-width: 560px">
	<h1><span class="mark">{@html MARK_SVG}</span> Gloss extension</h1>

	<section>
		<h2>Keyboard shortcut</h2>
		<p>
			Highlight text and press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> to ask about it. Change the key at
			<code>{shortcutsPage}</code>.
		</p>
	</section>

	<section>
		<h2>Settings</h2>
		<p>
			Whether page text is sent along with a question, which sites the extension stays off, and which agent answers are set in Gloss under
			<strong>Settings › Browser extension</strong>.
		</p>
		<p class="row">
			<button class="btn btn-accent" onclick={openGloss}>Open Gloss</button>
			<span class="muted">
				{#if status.state === 'connected'}Connected to Gloss {status.appVersion}.{:else if status.state === 'app_not_running'}Gloss isn't running.{/if}
			</span>
		</p>
		<ul class="muted">
			<li>Send page text: <strong>{status.settings.sendPageText ? 'on' : 'off'}</strong></li>
			<li>Sites left alone: <strong>{status.settings.denyList.length ? status.settings.denyList.join(', ') : 'none'}</strong></li>
		</ul>
	</section>

	<section>
		<h2>Privacy</h2>
		<p class="muted">
			The extension talks only to the Gloss app on this computer. It never contacts an AI service itself; Gloss sends your question, the highlighted
			passage with a little surrounding text and, when enabled, the page's text to the agent you chose in Gloss. Nothing is sent from private
			windows or from sites on the deny list, and nothing happens until you ask.
		</p>
	</section>
</div>
