<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Conversation header: title, project (a picker while the chat is a
	// draft), tags, pin, web-search toggle, model pill, clarification count
	// and the export menu. A web page's conversation shows the page's
	// favicon and title instead of the project controls.
	import { app, folderName } from '$lib/state/app.svelte';
	import { hostOf } from '$lib/state/threads';
	import Icon from './Icon.svelte';
	import ModelMenu from './ModelMenu.svelte';

	let editingTags = $state(false);
	let tagText = $state('');
	let tagInput: HTMLInputElement | undefined = $state();
	let editingTitle = $state(false);
	let titleText = $state('');
	let titleInput: HTMLInputElement | undefined = $state();
	let exportOpen = $state(false);
	let projectMenuOpen = $state(false);

	function startTags() {
		tagText = (app.active?.tags ?? []).join(', ');
		editingTags = true;
		setTimeout(() => tagInput?.focus(), 0);
	}

	function commitTags() {
		if (!editingTags) return;
		editingTags = false;
		const tags = tagText
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		if (tags.join(',') !== (app.active?.tags ?? []).join(',')) app.setTags(tags);
	}

	function startTitle() {
		if (!canRename || !app.active) return;
		titleText = app.active.title;
		editingTitle = true;
		setTimeout(() => {
			titleInput?.focus();
			titleInput?.select();
		}, 0);
	}

	function commitTitle() {
		if (!editingTitle) return;
		editingTitle = false;
		if (app.active) app.rename(app.active.id, titleText);
	}

	$effect(() => {
		if (!exportOpen) return;
		const close = (e: MouseEvent) => {
			if (!(e.target as HTMLElement).closest('[data-export]')) exportOpen = false;
		};
		document.addEventListener('mousedown', close);
		return () => document.removeEventListener('mousedown', close);
	});

	$effect(() => {
		if (!projectMenuOpen) return;
		const close = (e: MouseEvent) => {
			if (!(e.target as HTMLElement).closest('[data-project-menu]')) projectMenuOpen = false;
		};
		document.addEventListener('mousedown', close);
		return () => document.removeEventListener('mousedown', close);
	});

	function pickProject(path: string | null) {
		projectMenuOpen = false;
		app.chooseProject(path);
	}

	const page = $derived(app.activePage);
	const isPage = $derived(!!app.active?.pageKey);
	const title = $derived(
		page?.title || app.active?.title || app.viewing?.session.title || 'New conversation'
	);
	// A page's conversation is named after the page and renamed with it, so
	// only an ordinary conversation can be given a title here.
	const canRename = $derived(!!app.active && !isPage);
	const count = $derived(app.active?.clarifications.length ?? 0);
	const agent = $derived(app.activeAgent);
	const agentId = $derived(app.activeAgentId);
	const models = $derived(app.models[agentId] ?? []);
	const modelLabel = $derived(
		agent && !agent.supportsModelSelect ? 'Auto' : app.modelName(agentId, app.activeModelId)
	);
	const canPickModel = $derived((!agent || agent.supportsModelSelect) && !app.viewing);
	const showWeb = $derived((!agent || agent.supportsWebSearch) && !app.viewing);
</script>

<header data-tauri-drag-region>
	{#if isPage}
		<span class="favicon" title={page?.url ?? app.active?.pageKey ?? ''}>
			{#if page?.faviconUrl}
				<img src={page.faviconUrl} alt="" width="16" height="16" />
			{:else}
				<span class="letter"
					>{hostOf(page?.url ?? app.active?.pageKey ?? '')
						.charAt(0)
						.toUpperCase()}</span
				>
			{/if}
		</span>
	{/if}
	{#if editingTitle}
		<input
			bind:this={titleInput}
			class="iinput titleedit"
			aria-label="Conversation title"
			bind:value={titleText}
			onblur={commitTitle}
			onkeydown={(e) => {
				if (e.key === 'Enter') commitTitle();
				if (e.key === 'Escape') editingTitle = false;
			}}
		/>
	{:else if canRename}
		<h1 {title}>
			<button type="button" class="h1btn" title="Rename conversation" onclick={startTitle}
				>{title}</button
			>
		</h1>
	{:else}
		<h1 {title}>{title}</h1>
	{/if}
	{#if isPage}
		<span class="host">{hostOf(page?.url ?? app.active?.pageKey ?? '')}</span>
	{:else if app.draft}
		<div class="project-wrap" data-project-menu>
			<span class="folder" class:none={!app.activeProjectDir}>
				<button
					type="button"
					class="pick"
					title={app.activeProjectDir
						? `Agent runs in ${app.activeProjectDir}`
						: 'Run the agent inside one of your projects'}
					aria-haspopup="menu"
					aria-expanded={projectMenuOpen}
					onclick={() => (projectMenuOpen = !projectMenuOpen)}
				>
					<Icon name="folder" size={12} />
					<span class="fname"
						>{app.activeProjectDir ? folderName(app.activeProjectDir) : 'No project'}</span
					>
					<Icon name="chevron-down" size={11} />
				</button>
				{#if app.activeProjectDir}
					<button
						type="button"
						class="unbind"
						title="Start this chat outside any project"
						aria-label="Remove project"
						onclick={() => pickProject(null)}><Icon name="x" size={11} /></button
					>
				{/if}
			</span>
			{#if projectMenuOpen}
				<div class="menu left" role="menu">
					{#each app.projects as p (p.path)}
						<button
							type="button"
							role="menuitemradio"
							aria-checked={app.activeProjectDir === p.path}
							class:on={app.activeProjectDir === p.path}
							title={p.path}
							onclick={() => pickProject(p.path)}
						>
							<Icon name="folder" size={12} />
							<span class="fname">{p.name}</span>
						</button>
					{/each}
					{#if app.projects.length}<div class="sep"></div>{/if}
					<button
						type="button"
						role="menuitem"
						onclick={() => {
							projectMenuOpen = false;
							app.addProjectToDraft();
						}}
					>
						<Icon name="plus" size={12} />
						<span>Add project…</span>
					</button>
				</div>
			{/if}
		</div>
	{:else if app.activeProjectDir}
		<span class="folder" title="Agent runs in {app.activeProjectDir}">
			<Icon name="folder" size={12} />
			<span class="fname">{folderName(app.activeProjectDir)}</span>
		</span>
	{/if}
	{#if app.activeProjectDir && app.activeModes.length && !app.viewing}
		<select
			class="mode"
			title={app.activeModes.find((m) => m.id === app.activeMode)?.description ??
				'Reads files only; never changes them'}
			aria-label="Working mode"
			value={app.activeMode ?? 'read-only'}
			onchange={(e) =>
				app.setMode(e.currentTarget.value === 'read-only' ? null : e.currentTarget.value)}
		>
			<option value="read-only">Read only</option>
			{#each app.activeModes as m (m.id)}
				<option value={m.id}>{m.label}</option>
			{/each}
		</select>
	{/if}
	{#if app.active}
		{#if editingTags}
			<input
				bind:this={tagInput}
				class="iinput tagedit"
				placeholder="tags, comma separated"
				bind:value={tagText}
				onblur={commitTags}
				onkeydown={(e) => {
					if (e.key === 'Enter') commitTags();
					if (e.key === 'Escape') editingTags = false;
				}}
			/>
		{:else}
			<button type="button" class="tagbtn" title="Edit tags" onclick={startTags}>
				<Icon name="tag" size={12} />
				{#if app.active.tags.length}
					{#each app.active.tags as t (t)}<span class="tag">{t}</span>{/each}
				{:else}
					<span class="addtag">Add tags</span>
				{/if}
			</button>
		{/if}
		<button
			type="button"
			class="ico"
			class:on={app.active.pinned}
			title={app.active.pinned ? 'Unpin' : 'Pin'}
			aria-label={app.active.pinned ? 'Unpin conversation' : 'Pin conversation'}
			onclick={() => app.togglePin()}
		>
			<Icon name="pin" size={14} />
		</button>
	{/if}
	<div class="spacer" data-tauri-drag-region></div>
	{#if showWeb}
		<button
			type="button"
			class="pill web"
			class:on={app.activeWebSearch}
			title={app.activeWebSearch
				? 'Web search is on for this conversation'
				: 'Web search is off for this conversation'}
			onclick={() => app.setWebSearch(!app.activeWebSearch)}
		>
			<Icon name="globe" size={12} />
			Web {app.activeWebSearch ? 'on' : 'off'}
		</button>
	{/if}
	<div class="model-wrap">
		<button
			type="button"
			class="pill model"
			data-model-pill
			disabled={!canPickModel}
			aria-haspopup="menu"
			aria-expanded={app.modelMenuOpen}
			onclick={() => (app.modelMenuOpen = !app.modelMenuOpen)}
		>
			<span class="cmd mono">{agent?.command ?? agentId}</span>
			<span class="name">{modelLabel}</span>
			{#if canPickModel}<Icon name="chevron-down" size={12} />{/if}
		</button>
		{#if app.modelMenuOpen && canPickModel}
			<ModelMenu
				agentName={agent?.name ?? agentId}
				{models}
				selected={app.activeModelId}
				onselect={(id) => app.setModel(id)}
				onclose={() => (app.modelMenuOpen = false)}
			/>
		{/if}
	</div>
	{#if app.viewing}
		<button
			type="button"
			class="ibtn continue"
			title="Resume this session in Gloss; it stays in the agent's own history too"
			onclick={() => app.continueSession()}>Continue in Gloss</button
		>
	{:else if isPage}
		<span class="pill count">{count} ask{count === 1 ? '' : 's'}</span>
	{:else}
		<span class="pill count">{count} clarification{count === 1 ? '' : 's'}</span>
	{/if}
	{#if app.active && app.active.turns.length}
		<div class="export-wrap" data-export>
			<button
				type="button"
				class="ico"
				title="Export conversation"
				aria-label="Export conversation"
				aria-haspopup="menu"
				aria-expanded={exportOpen}
				onclick={() => (exportOpen = !exportOpen)}
			>
				<Icon name="download" size={14} />
			</button>
			{#if exportOpen}
				<div class="menu" role="menu">
					{#if isPage}
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								exportOpen = false;
								app.copyPageMarkdown();
							}}>Copy page notes as Markdown</button
						>
						<div class="hint">
							The page's title and link, then each highlighted passage with what was asked about it.
						</div>
					{:else}
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								exportOpen = false;
								app.copyConversationMarkdown();
							}}>Copy as Markdown</button
						>
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								exportOpen = false;
								app.saveConversationMarkdown();
							}}>Save as Markdown…</button
						>
						<div class="hint">
							Clarifications are folded in under the sentences they were asked about.
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</header>

<style>
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px 12px 24px;
		border-bottom: 1px solid var(--line);
		min-height: 54px;
	}
	h1 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 0 1 auto;
	}
	/* The title doubles as the rename control; it keeps the heading's look. */
	.h1btn {
		max-width: 100%;
		margin: 0 -6px;
		padding: 2px 6px;
		border-radius: 6px;
		font: inherit;
		color: inherit;
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.h1btn:hover {
		background: var(--surface-2);
	}
	.titleedit {
		height: 26px;
		font-size: 13px;
		font-weight: 600;
		padding: 0 8px;
		width: 320px;
		max-width: 50%;
	}
	.spacer {
		flex: 1;
		min-width: 10px;
		align-self: stretch;
	}
	.favicon {
		width: 20px;
		height: 20px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		background: var(--accent-tint);
		overflow: hidden;
	}
	.favicon img {
		display: block;
	}
	.letter {
		font-size: 11px;
		font-weight: 600;
		color: var(--accent-text);
	}
	.host {
		font-size: 11.5px;
		color: var(--text-3);
		white-space: nowrap;
		flex: none;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: var(--surface);
		font-size: 12px;
		white-space: nowrap;
	}
	.model {
		padding: 4px 8px 4px 10px;
		color: var(--text);
	}
	.model:disabled {
		cursor: default;
	}
	.model .cmd {
		font-size: 11px;
		color: var(--text-3);
	}
	.model-wrap {
		position: relative;
	}
	.count {
		padding: 3px 9px;
		color: var(--text-2);
	}
	.web {
		padding: 3px 9px;
		color: var(--text-3);
	}
	.web.on {
		color: var(--accent-text);
		background: var(--accent-tint);
	}
	.tagbtn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 6px;
		border-radius: 6px;
		color: var(--text-3);
		font-size: 11.5px;
		flex: none;
	}
	.tagbtn:hover {
		background: var(--surface);
		color: var(--text);
	}
	.tag {
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-2);
	}
	.addtag {
		font-style: italic;
	}
	.folder {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 4px 3px 7px;
		border-radius: 999px;
		background: var(--accent-tint);
		color: var(--accent-text);
		font-size: 11.5px;
		flex: none;
		max-width: 220px;
	}
	.folder.none {
		background: transparent;
		color: var(--text-3);
	}
	.folder.none:hover {
		background: var(--surface);
		color: var(--text);
	}
	.pick {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		color: inherit;
		font-size: inherit;
	}
	.project-wrap {
		position: relative;
		flex: none;
	}
	.menu.left {
		left: 0;
		right: auto;
		top: 30px;
		max-height: 320px;
		overflow-y: auto;
	}
	.menu button {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.menu button.on {
		color: var(--accent-text);
		font-weight: 500;
	}
	.sep {
		height: 1px;
		background: var(--line);
		margin: 4px 6px;
	}
	.fname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mode {
		height: 24px;
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text-2);
		font-size: 11.5px;
		flex: none;
	}
	.unbind {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		color: inherit;
		opacity: 0.7;
	}
	.unbind:hover {
		opacity: 1;
		background: var(--surface);
	}
	.tagedit {
		height: 26px;
		font-size: 12px;
		padding: 0 8px;
		width: 220px;
	}
	.ico {
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 7px;
		color: var(--text-3);
		flex: none;
	}
	.ico:hover {
		background: var(--surface);
		color: var(--text);
	}
	.ico.on {
		color: var(--accent-text);
	}
	.continue {
		height: 28px;
		padding: 0 12px;
		font-size: 12.5px;
		color: var(--accent-text);
		border-color: var(--accent);
	}
	.export-wrap {
		position: relative;
	}
	.menu {
		position: absolute;
		right: 0;
		top: 34px;
		z-index: 20;
		min-width: 230px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 10px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
		padding: 6px;
		display: flex;
		flex-direction: column;
	}
	.menu button {
		text-align: left;
		padding: 7px 10px;
		border-radius: 6px;
		font-size: 13px;
	}
	.menu button:hover {
		background: var(--surface);
	}
	.hint {
		font-size: 11px;
		color: var(--text-3);
		padding: 6px 10px 4px;
		line-height: 1.4;
	}
</style>
