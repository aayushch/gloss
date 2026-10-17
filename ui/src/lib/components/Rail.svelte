<script lang="ts">
	// Left navigation rail: new chat, search, tag filters, the pinned and
	// date-grouped conversation list with clarification sub-items under the
	// active conversation, full-text results while searching, and the footer.
	import { app, AGENT_NAMES } from '$lib/state/app.svelte';
	import { groupOf, pad, short, type Group } from '$lib/state/threads';
	import Icon from './Icon.svelte';
	import UpdateBanner from './UpdateBanner.svelte';

	const GROUPS: Group[] = ['Today', 'Yesterday', 'Last week', 'Older'];

	const grouped = $derived.by(() => {
		const out = new Map<string, typeof app.conversations>();
		for (const c of app.conversations) {
			const g = c.pinned ? 'Pinned' : groupOf(c.updatedAt);
			if (!out.has(g)) out.set(g, []);
			out.get(g)!.push(c);
		}
		return ['Pinned', ...GROUPS].filter((g) => out.has(g)).map((g) => ({ label: g, items: out.get(g)! }));
	});

	/** Search hits grouped by conversation, in the order they first appear. */
	const hitGroups = $derived.by(() => {
		const out = new Map<string, { title: string; hits: NonNullable<typeof app.searchHits> }>();
		for (const h of app.searchHits ?? []) {
			if (!out.has(h.conversationId)) out.set(h.conversationId, { title: h.title, hits: [] });
			if (h.turnId) out.get(h.conversationId)!.hits.push(h);
		}
		return [...out.entries()].map(([id, g]) => ({ id, ...g }));
	});

	/** Snippet pieces: text and whether it is a matched word. */
	function pieces(snippet: string): { t: string; hit: boolean }[] {
		return snippet
			.split(/([\u0001][^\u0002]*[\u0002])/)
			.filter(Boolean)
			.map((s) => (s.startsWith('\u0001') ? { t: s.slice(1, -1), hit: true } : { t: s, hit: false }));
	}

	const agentName = $derived(AGENT_NAMES[app.activeAgentId]);

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function onSearch(e: Event) {
		app.search = (e.currentTarget as HTMLInputElement).value;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => app.refreshList(), 150);
	}

	function isNested(id: string): boolean {
		return !!app.active?.clarifications.find((c) => c.id === id)?.parentId;
	}

	function confirmDelete(e: MouseEvent, id: string, title: string) {
		e.stopPropagation();
		if (confirm(`Delete “${title}”? The agent's own session files are kept.`)) app.remove(id);
	}

	function pin(e: MouseEvent, id: string) {
		e.stopPropagation();
		app.togglePin(id);
	}
</script>

<nav class="rail">
	<button type="button" class="ibtn newchat" onclick={() => app.newChat()}>
		<Icon name="plus" size={14} /> New chat
	</button>
	<input class="iinput search" type="search" placeholder="Search conversations" value={app.search} oninput={onSearch} />
	{#if app.tags.length}
		<div class="tags">
			{#each app.tags as t (t)}
				<button type="button" class="tagchip" class:on={app.tagFilter === t} onclick={() => app.setTagFilter(t)}>{t}</button>
			{/each}
		</div>
	{/if}

	<div class="list">
		{#if app.searchHits}
			{#if !hitGroups.length}
				<div class="none">No matches</div>
			{/if}
			{#each hitGroups as g (g.id)}
				<div class="group">
					<button type="button" class="navitem hitconv" class:on={app.active?.id === g.id} onclick={() => app.open(g.id)}>
						<span class="title">{g.title}</span>
					</button>
					{#each g.hits as h (h.turnId)}
						<button type="button" class="hit" onclick={() => app.openHit(h)}>
							<span class="who">{h.role === 'user' ? 'You' : 'Reply'}{h.clarificationId ? ' · clarification' : ''}</span>
							<span class="snip">{#each pieces(h.snippet) as p, i (i)}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}</span>
						</button>
					{/each}
				</div>
			{/each}
		{:else}
		{#if app.draft}
			<div class="group">
				<div class="glabel">Today</div>
				<div class="navitem on" aria-current="page"><span class="title">New conversation</span></div>
			</div>
		{/if}
		{#each grouped as g (g.label)}
			<div class="group">
				<div class="glabel">{g.label}</div>
				{#each g.items as c (c.id)}
					{@const current = app.active?.id === c.id}
					<div class="navitem" class:on={current} aria-current={current ? 'page' : undefined} role="button" tabindex="0" onclick={() => app.open(c.id)} onkeydown={(e) => e.key === 'Enter' && app.open(c.id)}>
						{#if c.projectDir}
							<span class="fmark" title={c.projectDir}><Icon name="folder" size={11} /></span>
						{/if}
						<span class="title">{c.title}</span>
						{#if c.clarificationCount > 0}
							<span class="countpill">{c.clarificationCount}</span>
						{/if}
						<button type="button" class="act" class:pinned={c.pinned} title={c.pinned ? 'Unpin' : 'Pin'} aria-label={c.pinned ? 'Unpin conversation' : 'Pin conversation'} onclick={(e) => pin(e, c.id)}><Icon name="pin" size={12} /></button>
						<button type="button" class="act" title="Delete conversation" aria-label="Delete conversation" onclick={(e) => confirmDelete(e, c.id, c.title)}><Icon name="trash" size={12} /></button>
					</div>
					{#if current && app.active}
						{#each app.active.clarifications as cl, i (cl.id)}
							<button type="button" class="navsub" class:nested={isNested(cl.id)} onclick={() => app.jumpTo(cl.id)}>
								<span class="dot"></span>
								<span class="sub">Clarification {pad(i + 1)} · {short(cl.quote, 26)}</span>
							</button>
						{/each}
					{/if}
				{/each}
			</div>
		{/each}
		{/if}
	</div>

	<UpdateBanner />

	<div class="foot">
		<div class="mark" aria-hidden="true"><svg viewBox="120 104 220 148" width="14" height="10" fill="currentColor"><g transform="rotate(180 230 178)"><path d="M136 236 V176 Q136 120 192 120 H200 V156 H196 Q176 156 176 176 V184 H212 V236 Z"/><path d="M248 236 V176 Q248 120 304 120 H312 V156 H308 Q288 156 288 176 V184 H324 V236 Z"/></g></svg></div>
		<div class="brand">
			<div class="app">Gloss</div>
			<div class="via">via {agentName}</div>
		</div>
		<button type="button" class="ico" title="Settings" aria-label="Settings" onclick={() => (app.settingsOpen = true)}><Icon name="settings" size={16} /></button>
		<button type="button" class="ico" title="Toggle theme" aria-label="Toggle theme" onclick={() => app.toggleTheme()}>
			<Icon name={app.settings.theme === 'dark' ? 'sun' : 'moon'} size={16} />
		</button>
	</div>
</nav>

<style>
	.rail {
		width: 232px;
		flex: none;
		background: var(--surface);
		border-right: 1px solid var(--line);
		padding: 12px 10px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		height: 100%;
	}
	.newchat {
		width: 100%;
		justify-content: flex-start;
		background: var(--bg);
	}
	.search {
		height: 30px;
		font-size: 12.5px;
		padding: 0 10px;
	}
	.list {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}
	.glabel {
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
		padding: 10px 10px 4px;
	}
	.navitem {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 7px 10px;
		border-radius: 8px;
		font-size: 13px;
		color: var(--text-2);
		cursor: pointer;
		text-align: left;
	}
	.navitem:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.navitem.on {
		background: var(--surface-2);
		color: var(--text);
		font-weight: 500;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fmark {
		display: inline-flex;
		color: var(--accent-text);
		flex: none;
	}
	.countpill {
		font-size: 10.5px;
		color: var(--accent-text);
		background: var(--accent-tint);
		padding: 1px 6px;
		border-radius: 999px;
		font-weight: 500;
	}
	.act {
		display: none;
		color: var(--text-3);
		padding: 2px;
		border-radius: 4px;
	}
	.navitem:hover .act,
	.act.pinned {
		display: inline-flex;
	}
	.act.pinned {
		color: var(--accent-text);
	}
	.act:hover {
		color: var(--accent-text);
		background: var(--surface);
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 0 2px;
	}
	.tagchip {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid var(--line);
		color: var(--text-2);
		background: var(--bg);
	}
	.tagchip:hover {
		color: var(--text);
	}
	.tagchip.on {
		color: var(--accent-text);
		background: var(--accent-tint);
		border-color: var(--accent);
	}
	.none {
		font-size: 12.5px;
		color: var(--text-3);
		padding: 16px 10px;
	}
	.hitconv {
		font-weight: 500;
	}
	.hit {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		padding: 5px 10px 6px 18px;
		text-align: left;
		border-radius: 6px;
		font-size: 12px;
		color: var(--text-2);
	}
	.hit:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.who {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
	}
	.snip {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		line-height: 1.4;
	}
	.snip mark {
		background: var(--accent-tint);
		color: var(--accent-text);
		border-radius: 2px;
	}
	.navsub {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		padding: 5px 10px 5px 22px;
		font-size: 12px;
		color: var(--text-2);
		text-align: left;
		border-radius: 6px;
	}
	.navsub.nested {
		padding-left: 34px;
	}
	.navsub:hover {
		color: var(--text);
		background: var(--surface-2);
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
	}
	.sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.foot {
		border-top: 1px solid var(--line);
		padding-top: 10px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.mark {
		width: 24px;
		height: 24px;
		border-radius: 7px;
		background: var(--text);
		color: var(--bg);
		font-size: 12px;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	.brand {
		flex: 1;
		min-width: 0;
		line-height: 1.25;
	}
	.app {
		font-size: 13px;
		font-weight: 600;
	}
	.via {
		font-size: 11px;
		color: var(--text-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ico {
		width: 30px;
		height: 30px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		color: var(--text-2);
	}
	.ico:hover {
		background: var(--surface-2);
		color: var(--text);
	}
</style>
