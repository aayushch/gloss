<script lang="ts">
	// Modal settings sheet: agent choice, default model per agent, appearance
	// and app updates.
	import { app } from '$lib/state/app.svelte';
	import { updater, type CheckResult } from '$lib/state/updater.svelte';
	import type { AgentId } from '$lib/api/types';
	import Icon from './Icon.svelte';

	const agents = $derived(app.agents);
	const selectedAgent = $derived(app.settings.defaultAgent);
	const models = $derived(app.models[selectedAgent] ?? []);
	const selectedModel = $derived(app.settings.defaultModel[selectedAgent] ?? models.find((m) => m.isDefault)?.id ?? '');
	const agentInfo = $derived(agents.find((a) => a.id === selectedAgent));

	function pickAgent(id: AgentId, available: boolean) {
		if (!available) return;
		app.saveSettings({ defaultAgent: id });
	}

	function pickModel(id: string) {
		app.saveSettings({ defaultModel: { [selectedAgent]: id } });
	}

	/** Outcome of the last check started from this sheet, for the result line. */
	let checkResult = $state<CheckResult | null>(null);

	async function checkNow() {
		checkResult = null;
		checkResult = await updater.check();
	}

	function lastChecked(at: number | null): string {
		if (!at) return 'never';
		const mins = Math.round((Date.now() - at) / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins} min ago`;
		return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') app.settingsOpen = false;
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (app.settingsOpen = false)}>
	<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
		<div class="titlebar">
			<h2 id="settings-title">Settings</h2>
			<button type="button" class="close" aria-label="Close" onclick={() => (app.settingsOpen = false)}><Icon name="x" size={16} /></button>
		</div>

		<section>
			<h3>Agent</h3>
			<p class="intro">Gloss talks to the coding agents installed on this machine. New conversations use the selected agent; each conversation stays bound to the agent that started it.</p>
			<div class="rows">
				{#each agents as a (a.id)}
					<button
						type="button"
						class="row"
						class:on={a.id === selectedAgent}
						class:off={!a.available}
						disabled={!a.available}
						role="radio"
						aria-checked={a.id === selectedAgent}
						onclick={() => pickAgent(a.id, a.available)}
					>
						<span class="mono-sq mono">{a.monogram}</span>
						<span class="text">
							<span class="name">{a.name}</span>
							<span class="cmd mono">{a.command}</span>
						</span>
						<span class="status" class:missing={!a.available}>
							{a.available ? `Installed${a.version ? ' · ' + a.version : ''}` : 'Not found on PATH'}
						</span>
						<span class="radio" class:on={a.id === selectedAgent}></span>
					</button>
				{/each}
			</div>
		</section>

		<section>
			<h3>Default model · {agentInfo?.name ?? selectedAgent}</h3>
			{#if agentInfo && !agentInfo.supportsModelSelect}
				<p class="intro">{agentInfo.name} chooses the model itself. Gloss leaves the CLI's own default untouched.</p>
			{:else if models.length === 0}
				<p class="intro">No model list available. The agent's own default is used.</p>
			{:else}
				<div class="rows">
					{#each models as m (m.id)}
						<button type="button" class="row" class:on={m.id === selectedModel} role="radio" aria-checked={m.id === selectedModel} onclick={() => pickModel(m.id)}>
							<span class="text">
								<span class="name">{m.name}</span>
								{#if m.note}<span class="cmd">{m.note}</span>{/if}
							</span>
							{#if m.context}<span class="ctx mono">{m.context}</span>{/if}
							<span class="radio" class:on={m.id === selectedModel}></span>
						</button>
					{/each}
				</div>
			{/if}
		</section>

		<section>
			<h3>Updates</h3>
			{#if !updater.supported}
				<p class="intro">Updates are checked in the desktop app only.</p>
			{:else}
				<p class="intro">
					Gloss {updater.currentVersion ?? ''} checks for a newer release shortly after launch and every two hours while open. Last checked: {lastChecked(updater.lastCheckedAt)}.
				</p>
				<div class="update">
					{#if updater.status === 'ready'}
						<span class="result">Version {updater.version} is installed. Restart to use it.</span>
						<button type="button" class="ibtn" onclick={() => updater.relaunch()}>Restart Gloss</button>
					{:else if updater.status === 'downloading'}
						<span class="result">Downloading {updater.version}… {updater.progress}%</span>
					{:else if updater.status === 'available'}
						<span class="result">Version {updater.version} is available.</span>
						<button type="button" class="ibtn" onclick={() => updater.install()}>Update</button>
					{:else}
						<button type="button" class="ibtn" disabled={updater.status === 'checking'} onclick={checkNow}>
							{updater.status === 'checking' ? 'Checking…' : 'Check for updates'}
						</button>
						{#if updater.status === 'error' && checkResult === 'error'}
							<span class="result err" title={updater.error ?? ''}>Check failed. {updater.error ?? ''}</span>
						{:else if checkResult === 'up-to-date'}
							<span class="result">You are up to date.</span>
						{/if}
					{/if}
				</div>
			{/if}
		</section>

		<section>
			<h3>Appearance</h3>
			<div class="seg" role="radiogroup" aria-label="Appearance">
				<button type="button" class:on={app.settings.theme === 'light'} onclick={() => app.applyTheme('light')}>Light</button>
				<button type="button" class:on={app.settings.theme === 'dark'} onclick={() => app.applyTheme('dark')}>Dark</button>
			</div>
		</section>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(20, 16, 12, 0.35);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
	}
	.sheet {
		width: 480px;
		max-width: calc(100vw - 32px);
		max-height: calc(100vh - 48px);
		overflow: auto;
		background: var(--bg);
		border-radius: 14px;
		border: 1px solid var(--line);
		box-shadow: var(--shadow);
		padding: 18px 20px 20px;
	}
	.titlebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.close {
		width: 30px;
		height: 30px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		color: var(--text-2);
	}
	.close:hover {
		background: var(--surface);
	}
	section {
		margin-top: 18px;
	}
	h3 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
	}
	.intro {
		margin: 0 0 10px;
		font-size: 12.5px;
		color: var(--text-2);
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
		text-align: left;
		color: var(--text);
	}
	.row:hover:not(:disabled) {
		background: var(--surface);
	}
	.row.on {
		border-color: var(--accent);
		background: var(--surface);
	}
	.row.off {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.mono-sq {
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 7px;
		background: var(--surface-2);
		font-size: 12px;
		flex: none;
	}
	.text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.name {
		font-size: 13.5px;
		font-weight: 500;
	}
	.cmd {
		font-size: 11.5px;
		color: var(--text-3);
	}
	.status {
		font-size: 11.5px;
		color: var(--text-3);
		white-space: nowrap;
	}
	.status.missing {
		color: var(--accent-text);
	}
	.ctx {
		font-size: 11.5px;
		color: var(--text-3);
	}
	.radio {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 1px solid var(--line);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	.radio.on {
		border-color: var(--accent);
	}
	.radio.on::after {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
	}
	.update {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.result {
		font-size: 12.5px;
		color: var(--text-2);
	}
	.result.err {
		color: var(--accent-text);
	}
	.seg {
		display: inline-flex;
		border: 1px solid var(--line);
		border-radius: 8px;
		overflow: hidden;
	}
	.seg button {
		padding: 6px 14px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-2);
	}
	.seg button.on {
		background: var(--accent);
		color: var(--on-accent);
	}
</style>
