<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Modal settings sheet with four panes, picked from a list on the left:
	// General (appearance, updates), Agents (agent choice, default model
	// per agent), Browser extension (install, status) and Web pages (what
	// the extension sends and which agent answers).
	import { app, AGENT_NAMES, type SettingsTab } from '$lib/state/app.svelte';
	import { updater, type CheckResult } from '$lib/state/updater.svelte';
	import type { AgentId, BrowserRegistration, SessionInfo } from '$lib/api/types';
	import Icon from './Icon.svelte';
	import { isOlder } from '$lib/version';

	const TABS: { id: SettingsTab; label: string }[] = [
		{ id: 'general', label: 'General' },
		{ id: 'agents', label: 'Agents' },
		{ id: 'extension', label: 'Browser extension' },
		{ id: 'pages', label: 'Web pages' }
	];
	const tab = $derived(app.settingsTab);

	const agents = $derived(app.agents);
	const selectedAgent = $derived(app.settings.defaultAgent);
	const models = $derived(app.models[selectedAgent] ?? []);
	const selectedModel = $derived(
		app.settings.defaultModel[selectedAgent] ?? models.find((m) => m.isDefault)?.id ?? ''
	);
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

	// ── browser extension ───────────────────────────────────────────────

	const ext = $derived(app.extension);
	const isMac =
		typeof document !== 'undefined' && document.documentElement.dataset.platform === 'macos';
	/** The per-browser registration rows and the re-register actions, hidden unless asked for or something is wrong. */
	let showDetails = $state(false);

	/** The Chromium browsers found on this machine, by name. */
	const chromiumInstalled = $derived(
		(ext?.browsers ?? []).filter((b) => b.family === 'chromium' && b.installed).map((b) => b.name)
	);
	const firefoxInstalled = $derived(
		(ext?.browsers ?? []).some((b) => b.family === 'firefox' && b.installed)
	);

	/** The Chrome Web Store serves every Chromium browser; the button names the one that is installed. */
	const storeLabel = $derived.by(() => {
		const name = chromiumInstalled[0] ?? 'Chrome';
		const known = ['Brave', 'Edge', 'Arc', 'Vivaldi', 'Chrome'].find((k) => name.includes(k));
		return `Get for ${known ?? 'Chrome'}`;
	});

	/** True when a row would need the user's attention, so the details open on their own. */
	const registrationProblem = $derived(
		(ext?.browsers ?? []).some((b) => b.installed && (!b.registered || !!b.error))
	);

	function browserStatus(b: BrowserRegistration): string {
		if (!b.installed) return 'Not installed';
		if (b.error) return `Error: ${b.error}`;
		return b.registered ? 'Registered' : 'Not registered';
	}

	function sessionLabel(s: SessionInfo): string {
		const name = s.browser ? s.browser.charAt(0).toUpperCase() + s.browser.slice(1) : 'Browser';
		const label = `${name} ${s.extensionVersion} connected`;
		return ext && isOlder(s.extensionVersion, ext.bundledVersion)
			? `${label}; Gloss ships ${ext.bundledVersion}`
			: label;
	}

	/** True while a connected Firefox runs an older add-on than the one inside Gloss. */
	const firefoxOutdated = $derived(app.outdatedExtensions.some((s) => s.browser === 'firefox'));

	/** A short list of names: "Chrome, Brave and Firefox". */
	function joinNames(names: string[]): string {
		if (names.length <= 1) return names[0] ?? '';
		return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
	}

	const registeredNames = $derived(
		(ext?.browsers ?? []).filter((b) => b.installed && b.registered && !b.error).map((b) => b.name)
	);

	const safariState = $derived.by(() => {
		if (app.safariEnabled === true) return { label: 'Enabled', ok: true };
		if (app.safariEnabled === false) return { label: 'Off in Safari', ok: false };
		return { label: app.safariError ? 'Not reported by Safari' : 'Checking…', ok: false };
	});

	// Safari reports the extension's state on request only, so while the
	// sheet is open it is asked every few seconds; that is how the row
	// flips to "Enabled" right after the user ticks it in Safari.
	$effect(() => {
		if (!isMac || !ext?.safariAvailable) return;
		void app.refreshSafariState();
		const timer = setInterval(() => void app.refreshSafariState(), 3000);
		return () => clearInterval(timer);
	});

	/** The deny list as typed; saved on blur so every keystroke does not hit the engine. */
	let denyText = $state(app.settings.pageDenyList.join('\n'));
	$effect(() => {
		denyText = app.settings.pageDenyList.join('\n');
	});

	function commitDenyList() {
		const list = [
			...new Set(
				denyText
					.split(/[\n,]/)
					.map((h) => h.trim().toLowerCase())
					.filter(Boolean)
			)
		];
		if (list.join('\n') !== app.settings.pageDenyList.join('\n'))
			app.saveSettings({ pageDenyList: list });
	}

	$effect(() => {
		app.refreshExtensionStatus();
	});

	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') app.settingsOpen = false;
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});
</script>

<div
	class="backdrop"
	role="presentation"
	onmousedown={(e) => e.target === e.currentTarget && (app.settingsOpen = false)}
>
	<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
		<div class="titlebar">
			<h2 id="settings-title">Settings</h2>
			<button
				type="button"
				class="close"
				aria-label="Close"
				onclick={() => (app.settingsOpen = false)}><Icon name="x" size={16} /></button
			>
		</div>
		<div class="body">
			<nav class="tabs" aria-label="Settings sections">
				{#each TABS as t (t.id)}
					<button
						type="button"
						class="tab"
						class:on={tab === t.id}
						aria-current={tab === t.id ? 'page' : undefined}
						onclick={() => (app.settingsTab = t.id)}>{t.label}</button
					>
				{/each}
			</nav>
			<div class="pane">
				{#if tab === 'agents'}
					<section>
						<h3>Agent</h3>
						<p class="intro">
							Gloss talks to the coding agents installed on this machine. New conversations use the
							selected agent; each conversation stays bound to the agent that started it.
						</p>
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
										{a.available
											? `Installed${a.version ? ' · ' + a.version : ''}`
											: 'Not found on PATH'}
									</span>
									<span class="radio" class:on={a.id === selectedAgent}></span>
								</button>
							{/each}
						</div>
					</section>

					<section>
						<h3>Default model · {agentInfo?.name ?? selectedAgent}</h3>
						{#if agentInfo && !agentInfo.supportsModelSelect}
							<p class="intro">
								{agentInfo.name} chooses the model itself. Gloss leaves the CLI's own default untouched.
							</p>
						{:else if models.length === 0}
							<p class="intro">No model list available. The agent's own default is used.</p>
						{:else}
							<div class="rows">
								{#each models as m (m.id)}
									<button
										type="button"
										class="row"
										class:on={m.id === selectedModel}
										role="radio"
										aria-checked={m.id === selectedModel}
										onclick={() => pickModel(m.id)}
									>
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
				{/if}

				{#if tab === 'general'}
					<section>
						<h3>Appearance</h3>
						<div class="seg" role="radiogroup" aria-label="Appearance">
							<button
								type="button"
								class:on={app.settings.theme === 'light'}
								onclick={() => app.applyTheme('light')}>Light</button
							>
							<button
								type="button"
								class:on={app.settings.theme === 'dark'}
								onclick={() => app.applyTheme('dark')}>Dark</button
							>
						</div>
					</section>

					<section>
						<h3>Updates</h3>
						{#if !updater.supported}
							<p class="intro">Updates are checked in the desktop app only.</p>
						{:else}
							<p class="intro">
								Gloss {updater.currentVersion ?? ''} checks for a newer release shortly after launch and
								every two hours while open. Last checked: {lastChecked(updater.lastCheckedAt)}.
							</p>
							<div class="update">
								{#if updater.status === 'ready'}
									<span class="result"
										>Version {updater.version} is installed. Restart to use it.</span
									>
									<button type="button" class="ibtn" onclick={() => updater.relaunch()}
										>Restart Gloss</button
									>
								{:else if updater.status === 'downloading'}
									<span class="result">Downloading {updater.version}… {updater.progress}%</span>
								{:else if updater.status === 'available'}
									<span class="result">Version {updater.version} is available.</span>
									<button type="button" class="ibtn" onclick={() => updater.install()}
										>Update</button
									>
								{:else}
									<button
										type="button"
										class="ibtn"
										disabled={updater.status === 'checking'}
										onclick={checkNow}
									>
										{updater.status === 'checking' ? 'Checking…' : 'Check for updates'}
									</button>
									{#if updater.status === 'error' && checkResult === 'error'}
										<span class="result err" title={updater.error ?? ''}
											>Check failed. {updater.error ?? ''}</span
										>
									{:else if checkResult === 'up-to-date'}
										<span class="result">You are up to date.</span>
									{/if}
								{/if}
							</div>
						{/if}
					</section>
				{/if}

				{#if tab === 'extension'}
					<section>
						<h3>Browser extension</h3>
						<p class="intro">
							Highlight text on any web page and ask about it. The reply stays anchored to the
							passage, and every page you ask about appears under Pages in the rail.
						</p>
						{#if !ext}
							<p class="intro">Reading the extension status…</p>
						{:else}
							{#if ext.translocated}
								<div class="warn">
									Move Gloss to the Applications folder so browsers can find it. macOS runs it from
									a temporary copy right now, and the registered paths point there.
								</div>
							{/if}
							<div class="cards">
								<div class="card">
									<span class="text">
										<span class="name"
											>{chromiumInstalled.length
												? joinNames(chromiumInstalled)
												: 'Chrome, Brave, Edge, Arc, Vivaldi'}</span
										>
										<span class="cmd"
											>Installs from the Chrome Web Store; these browsers take extensions from
											nowhere else.</span
										>
									</span>
									<button type="button" class="ibtn" onclick={() => app.openUrl(ext.chromeStoreUrl)}
										>{storeLabel}</button
									>
								</div>
								<div class="card" class:off={!firefoxInstalled}>
									<span class="text">
										<span class="name">Firefox</span>
										<span class="cmd"
											>{ext.xpiBundled
												? 'The add-on ships inside Gloss; Firefox asks once to install it.'
												: 'This build of Gloss does not include the Firefox add-on.'}</span
										>
									</span>
									<button
										type="button"
										class="ibtn"
										disabled={!ext.xpiBundled}
										title={ext.firefoxXpiPath ?? ''}
										onclick={() =>
											firefoxOutdated
												? app.updateFirefoxExtension()
												: app.installFirefoxExtension()}
										>{firefoxOutdated ? 'Update in Firefox' : 'Install in Firefox'}</button
									>
								</div>
								{#if isMac}
									<div class="card">
										<span class="text">
											<span class="name">Safari</span>
											{#if ext.safariAvailable}
												<span class="cmd"
													>The extension ships inside Gloss; Safari keeps it off until you tick it
													under Settings › Extensions.</span
												>
												{#if app.safariPrompted && app.safariEnabled !== true}
													<span class="cmd hint"
														>Safari's Extensions settings are open. Tick Gloss there; this row
														updates by itself.</span
													>
												{/if}
											{:else}
												<span class="cmd"
													>This build of Gloss does not include the Safari extension.</span
												>
											{/if}
										</span>
										{#if ext.safariAvailable}
											<span
												class="status"
												class:ok={safariState.ok}
												class:missing={app.safariEnabled === false}
												title={app.safariError ?? ''}>{safariState.label}</span
											>
											<button type="button" class="ibtn" onclick={() => app.openSafariExtensions()}
												>{app.safariEnabled ? 'Safari settings' : 'Turn on in Safari'}</button
											>
										{/if}
									</div>
								{/if}
							</div>
							{#if ext.sessions.length}
								<ul class="sessions">
									{#each ext.sessions as s (s.id)}
										<li><span class="live"></span>{sessionLabel(s)}</li>
									{/each}
								</ul>
							{:else}
								<p class="intro quiet">
									No browser is connected right now. A connected browser shows up here as soon as a
									page with the extension is open.
								</p>
							{/if}
							<button
								type="button"
								class="details-toggle"
								aria-expanded={showDetails || registrationProblem}
								onclick={() => (showDetails = !showDetails)}
							>
								<span class="chev" class:open={showDetails || registrationProblem}>›</span>
								{#if registrationProblem}
									A browser is not registered
								{:else if registeredNames.length}
									Registered with {joinNames(registeredNames)}
								{:else}
									How browsers reach Gloss
								{/if}
							</button>
							{#if showDetails || registrationProblem}
								<div class="details">
									<p class="intro">
										Chrome-family browsers and Firefox reach Gloss through a small helper, <span
											class="mono">gloss-bridge</span
										>, that the browser starts itself. A browser only starts a helper listed in its
										native-messaging folder, so Gloss writes that entry for every browser it finds,
										at every launch. Nothing here needs doing unless a row says otherwise. Safari
										works differently: its extension talks to Gloss over a port open to this Mac
										only, with a token that changes at every launch.
									</p>
									<div class="rows">
										{#each ext.browsers as b (b.id)}
											<div class="row static" class:off={!b.installed}>
												<span class="text">
													<span class="name">{b.name}</span>
													<span class="cmd" title={b.manifestPath}
														>{b.family === 'firefox' ? 'Firefox add-on' : 'Chrome Web Store'}</span
													>
												</span>
												<span
													class="status"
													class:missing={b.installed && (!b.registered || !!b.error)}
													class:ok={b.installed && b.registered && !b.error}
													>{browserStatus(b)}</span
												>
											</div>
										{/each}
									</div>
									<div class="actions">
										<button type="button" class="ibtn ghost" onclick={() => app.registerHosts()}
											>Re-register</button
										>
										<button type="button" class="ibtn ghost" onclick={() => app.unregisterHosts()}
											>Unregister</button
										>
										<span class="result mono path" title={ext.bridgePath}>{ext.bridgePath}</span>
									</div>
								</div>
							{/if}
						{/if}
					</section>
				{/if}

				{#if tab === 'pages'}
					<section class="pages">
						<h3>Web pages</h3>
						<p class="intro">
							What the browser extension sends along with a question, and which agent answers.
						</p>
						<div class="prefs">
							<label class="toggle">
								<input
									type="checkbox"
									checked={app.settings.sendPageText}
									onchange={(e) => app.saveSettings({ sendPageText: e.currentTarget.checked })}
								/>
								<span class="switch"></span>
								<span class="text">
									<span class="name">Send page text to the agent</span>
									<span class="cmd"
										>The page's readable text goes along with an ask so the agent can read around
										the passage.</span
									>
								</span>
							</label>
							<label class="field">
								<span class="name">Never ask about these hosts</span>
								<span class="cmd"
									>One host per line; <span class="mono">*.example.com</span> covers subdomains.</span
								>
								<textarea
									class="iinput deny"
									rows="3"
									placeholder="mail.example.com"
									bind:value={denyText}
									onblur={commitDenyList}></textarea>
							</label>
							{#if isMac}
								<label class="toggle">
									<input
										type="checkbox"
										checked={app.settings.safariBridge}
										onchange={(e) => app.saveSettings({ safariBridge: e.currentTarget.checked })}
									/>
									<span class="switch"></span>
									<span class="text">
										<span class="name">Safari bridge</span>
										<span class="cmd"
											>Listen on this Mac only{ext?.loopbackPort
												? ` (port ${ext.loopbackPort})`
												: ''} so the Safari extension can reach Gloss.</span
										>
										{#if ext?.safariBridgeError}
											<span class="cmd err"
												>Safari cannot reach Gloss: the port and token could not be written where
												its extension reads them ({ext.safariBridgeError}).</span
											>
										{/if}
									</span>
								</label>
							{/if}
							<label class="field inline">
								<span class="text">
									<span class="name">Page agent</span>
									<span class="cmd">Answers questions asked from the browser.</span>
								</span>
								<select
									class="pick"
									value={app.settings.pageAgent ?? ''}
									onchange={(e) =>
										app.saveSettings({
											pageAgent: (e.currentTarget.value || null) as AgentId | null
										})}
								>
									<option value="">Default agent ({AGENT_NAMES[app.settings.defaultAgent]})</option>
									{#each app.agents as a (a.id)}
										<option value={a.id} disabled={!a.available}
											>{a.name}{a.available ? '' : ' (not installed)'}</option
										>
									{/each}
								</select>
							</label>
						</div>
					</section>
				{/if}
			</div>
		</div>
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
		width: 660px;
		max-width: calc(100vw - 32px);
		height: 560px;
		max-height: calc(100vh - 48px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg);
		border-radius: 14px;
		border: 1px solid var(--line);
		box-shadow: var(--shadow);
	}
	.body {
		display: flex;
		flex: 1;
		min-height: 0;
	}
	.tabs {
		width: 160px;
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 10px;
		border-right: 1px solid var(--line);
		background: var(--surface);
	}
	.tab {
		padding: 7px 10px;
		border-radius: 8px;
		text-align: left;
		font-size: 13px;
		color: var(--text-2);
	}
	.tab:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.tab.on {
		background: var(--surface-2);
		color: var(--text);
		font-weight: 500;
	}
	.pane {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		padding: 0 20px 20px;
	}
	.pane section:first-child {
		margin-top: 14px;
	}
	.pages .prefs {
		margin-top: 0;
		padding-top: 0;
		border-top: 0;
	}
	.titlebar {
		padding: 14px 20px 10px;
		border-bottom: 1px solid var(--line);
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
	.row.static {
		cursor: default;
	}
	.status.ok {
		color: var(--text-2);
	}
	.warn {
		font-size: 12.5px;
		color: var(--accent-text);
		background: var(--accent-tint);
		border: 1px solid var(--accent);
		border-radius: 8px;
		padding: 8px 10px;
		margin-bottom: 10px;
	}
	.sessions {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-2);
	}
	.sessions li {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.live {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
	}
	.quiet {
		margin: 8px 0 0;
		color: var(--text-3);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.path {
		font-size: 11px;
		color: var(--text-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1;
	}
	.cards {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 10px;
		border: 1px solid var(--line);
		border-radius: 10px;
	}
	.card.off {
		opacity: 0.6;
	}
	.card .text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.card .ibtn {
		flex: none;
	}
	.cmd.hint,
	.cmd.err {
		color: var(--accent-text);
	}
	.details-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		padding: 2px 0;
		border: 0;
		background: none;
		color: var(--text-2);
		font-size: 12.5px;
		cursor: pointer;
	}
	.details-toggle:hover {
		color: var(--text);
	}
	.chev {
		display: inline-block;
		width: 10px;
		font-size: 15px;
		line-height: 1;
		transition: transform 120ms ease;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.details {
		margin-top: 8px;
		padding: 10px;
		border: 1px dashed var(--line);
		border-radius: 10px;
	}
	.prefs {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}
	.toggle {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		cursor: pointer;
	}
	.toggle input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.switch {
		width: 30px;
		height: 18px;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--line);
		position: relative;
		flex: none;
		margin-top: 1px;
		transition: background 120ms ease;
	}
	.switch::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--bg);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
		transition: transform 120ms ease;
	}
	.toggle input:checked + .switch {
		background: var(--accent);
		border-color: var(--accent);
	}
	.toggle input:checked + .switch::after {
		transform: translateX(12px);
	}
	.toggle input:focus-visible + .switch {
		box-shadow: 0 0 0 3px var(--accent-tint);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.field.inline {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.deny {
		margin-top: 4px;
		font-size: 12.5px;
		font-family: var(--mono);
		resize: vertical;
		min-height: 56px;
	}
	.pick {
		height: 28px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font-size: 12.5px;
		flex: none;
		max-width: 220px;
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
