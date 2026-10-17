<script lang="ts">
	// Conversation header: title, tags, pin, web-search toggle, model pill,
	// clarification count and the export menu.
	import { titleMouseDown } from '$lib/drag';
	import { app } from '$lib/state/app.svelte';
	import Icon from './Icon.svelte';
	import ModelMenu from './ModelMenu.svelte';

	let editingTags = $state(false);
	let tagText = $state('');
	let tagInput: HTMLInputElement | undefined = $state();
	let exportOpen = $state(false);

	function startTags() {
		tagText = (app.active?.tags ?? []).join(', ');
		editingTags = true;
		setTimeout(() => tagInput?.focus(), 0);
	}

	function commitTags() {
		if (!editingTags) return;
		editingTags = false;
		const tags = tagText.split(',').map((t) => t.trim()).filter(Boolean);
		if (tags.join(',') !== (app.active?.tags ?? []).join(',')) app.setTags(tags);
	}

	$effect(() => {
		if (!exportOpen) return;
		const close = (e: MouseEvent) => {
			if (!(e.target as HTMLElement).closest('[data-export]')) exportOpen = false;
		};
		document.addEventListener('mousedown', close);
		return () => document.removeEventListener('mousedown', close);
	});

	const title = $derived(app.active?.title ?? 'New conversation');
	const count = $derived(app.active?.clarifications.length ?? 0);
	const agent = $derived(app.activeAgent);
	const agentId = $derived(app.activeAgentId);
	const models = $derived(app.models[agentId] ?? []);
	const modelLabel = $derived(agent && !agent.supportsModelSelect ? 'Auto' : app.modelName(agentId, app.activeModelId));
	const canPickModel = $derived(!agent || agent.supportsModelSelect);
	const showWeb = $derived(!agent || agent.supportsWebSearch);
</script>

<!-- The header doubles as the title bar: pressing anywhere outside a control drags the window. -->
<header onmousedown={titleMouseDown} role="presentation">
	<h1 title={title}>{title}</h1>
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
		<button type="button" class="ico" class:on={app.active.pinned} title={app.active.pinned ? 'Unpin' : 'Pin'} aria-label={app.active.pinned ? 'Unpin conversation' : 'Pin conversation'} onclick={() => app.togglePin()}>
			<Icon name="pin" size={14} />
		</button>
	{/if}
	<div class="spacer"></div>
	{#if showWeb}
		<button
			type="button"
			class="pill web"
			class:on={app.activeWebSearch}
			title={app.activeWebSearch ? 'Web search is on for this conversation' : 'Web search is off for this conversation'}
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
			<ModelMenu agentName={agent?.name ?? agentId} {models} selected={app.activeModelId} onselect={(id) => app.setModel(id)} onclose={() => (app.modelMenuOpen = false)} />
		{/if}
	</div>
	<span class="pill count">{count} clarification{count === 1 ? '' : 's'}</span>
	{#if app.active && app.active.turns.length}
		<div class="export-wrap" data-export>
			<button type="button" class="ico" title="Export conversation" aria-label="Export conversation" aria-haspopup="menu" aria-expanded={exportOpen} onclick={() => (exportOpen = !exportOpen)}>
				<Icon name="download" size={14} />
			</button>
			{#if exportOpen}
				<div class="menu" role="menu">
					<button type="button" role="menuitem" onclick={() => { exportOpen = false; app.copyConversationMarkdown(); }}>Copy as Markdown</button>
					<button type="button" role="menuitem" onclick={() => { exportOpen = false; app.saveConversationMarkdown(); }}>Save as Markdown…</button>
					<div class="hint">Clarifications are folded in under the sentences they were asked about.</div>
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
	.spacer {
		flex: 1;
		min-width: 10px;
		align-self: stretch;
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
