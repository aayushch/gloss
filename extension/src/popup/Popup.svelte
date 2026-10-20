<script lang="ts">
	// The toolbar popup: connection status, this page's asks, an ask about
	// the whole page, and recently asked pages.
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '../shared/browser';
	import { connectClient, type Client } from '../shared/client';
	import type { ConnectionStatus, PageTextReply, TabMessage } from '../shared/messages';
	import {
		DEFAULT_SETTINGS,
		failureOf,
		type Clarification,
		type GetPageResult,
		type ListRecentPagesResult,
		type Page,
		type PageAskRequest,
		type PageAskResult,
		type Turn,
		type TurnEventEnvelope,
	} from '../shared/protocol';
	import { applyToTurn, isLive } from '../shared/reply';
	import { renderMarkdown } from '../content/markdown';

	let client: Client;
	let status = $state<ConnectionStatus>({ state: 'connecting', settings: DEFAULT_SETTINGS });
	let tab = $state<chrome.tabs.Tab | null>(null);
	let page = $state<GetPageResult | null>(null);
	let pageError = $state<string | null>(null);
	let recent = $state<Page[]>([]);
	let question = $state('');
	let reply = $state<Turn | null>(null);
	let askError = $state<string | null>(null);
	let sending = $state(false);
	let launching = $state(false);

	const asks = $derived((page?.page.conversation.clarifications ?? []).filter((c) => c.webAnchor));
	const orphans = $derived(asks.filter((c) => c.anchorState === 'orphan').length);
	const connected = $derived(status.state === 'connected');
	const running = $derived(page?.page.conversation.running || isLive(reply));
	const askable = $derived(!!tab?.url && /^(https?|file):/.test(tab.url));

	const statusText = $derived.by(() => {
		switch (status.state) {
			case 'connected':
				return `Connected to Gloss ${status.appVersion ?? ''}`.trim();
			case 'app_not_running':
				return "Gloss isn't running";
			case 'host_missing':
				return 'The Gloss bridge is not installed. Open Gloss once to set it up.';
			case 'protocol_mismatch':
				return status.mismatch === 'update_app' ? 'Update Gloss to use this extension.' : 'Update the Gloss extension.';
			case 'connecting':
				return 'Connecting to Gloss…';
			default:
				return status.message ?? 'Cannot reach Gloss';
		}
	});

	async function loadPage() {
		if (!tab?.url || !connected || !askable) return;
		try {
			page = await client.request<GetPageResult>('getPage', { url: tab.url, title: tab.title ?? '' });
			pageError = null;
			client.subscribe({ urlKey: page.urlKey, conversationId: page.page.conversation.id });
		} catch (e) {
			pageError = failureOf(e).message;
		}
	}

	async function loadRecent() {
		if (!connected) return;
		try {
			const r = await client.request<ListRecentPagesResult>('listRecentPages', { limit: 12 });
			recent = r.pages.filter((p) => p.urlKey !== page?.urlKey);
		} catch {
			recent = [];
		}
	}

	function onEvent(event: string, data: unknown) {
		if (event === 'connection') {
			const was = connected;
			status = data as ConnectionStatus;
			if (connected && !was) void refresh();
		} else if (event === 'turn') {
			const env = data as TurnEventEnvelope;
			if (reply) reply = applyToTurn(reply, env);
			if (page && env.conversationId === page.page.conversation.id) {
				const t = env.event.type;
				if (t === 'started') page.page.conversation.running = true;
				if (t === 'done' || t === 'failed' || t === 'cancelled') page.page.conversation.running = false;
			}
		} else if (event === 'page') {
			void loadPage();
		} else if (event === 'app_state' && (data as { running: boolean }).running) {
			launching = false;
			void refresh();
		}
	}

	async function refresh() {
		await loadPage();
		await loadRecent();
	}

	onMount(async () => {
		client = connectClient();
		client.onEvent(onEvent);
		const [active] = await browser.tabs.query({ active: true, currentWindow: true });
		tab = active ?? null;
		status = await client.status();
		await refresh();
	});

	onDestroy(() => client?.close());

	async function sendToTab<T>(msg: TabMessage): Promise<T | null> {
		if (!tab?.id) return null;
		try {
			return (await browser.tabs.sendMessage(tab.id, msg)) as T;
		} catch {
			return null;
		}
	}

	async function focusAsk(c: Clarification) {
		await sendToTab({ type: 'focus-ask', clarificationId: c.id });
		window.close();
	}

	async function askPage() {
		const q = question.trim();
		if (!q || !tab?.url || sending || running) return;
		sending = true;
		askError = null;
		const text = await sendToTab<PageTextReply>({ type: 'page-text' });
		const payload: PageAskRequest = {
			page: { url: tab.url, title: tab.title ?? text?.title ?? '', faviconUrl: text?.faviconUrl ?? tab.favIconUrl ?? null },
			anchor: null,
			context: { before: '', after: '' },
			question: q,
			pageText: status.settings.sendPageText ? (text?.text ?? null) : null,
			private: Boolean(tab.incognito),
		};
		try {
			const r = await client.request<PageAskResult>('askPage', payload);
			reply = r.assistantTurn;
			question = '';
			page = page ?? null;
			client.subscribe({ urlKey: r.urlKey, conversationId: r.conversationId });
			if (page) page.page.conversation.running = true;
		} catch (e) {
			const f = failureOf(e);
			askError = f.code === 'app_not_running' ? "Gloss isn't running." : f.code === 'busy' ? 'Gloss is still answering a question on this page.' : f.message;
		} finally {
			sending = false;
		}
	}

	function launch() {
		launching = true;
		client.request('launchApp', { urlKey: page?.urlKey }).catch(() => (launching = false));
	}

	function cancel() {
		const id = page?.page.conversation.id ?? reply?.conversationId;
		if (id) client.request('cancel', { conversationId: id }).catch(() => {});
	}

	function openInGloss() {
		if (!page) return;
		client.request('openInGloss', { urlKey: page.urlKey }).catch(() => launch());
	}

	function openPage(p: Page) {
		void browser.tabs.create({ url: p.url });
		window.close();
	}

	function shortQuote(c: Clarification): string {
		return c.quote.length > 70 ? c.quote.slice(0, 70) + '…' : c.quote;
	}
</script>

<div class="page popup">
	<h1><span class="mark">“</span> Gloss</h1>

	<div class="status" class:is-ok={connected} class:is-bad={!connected && status.state !== 'connecting'}>
		<span class="dot"></span>
		<span class="text">{statusText}</span>
		{#if status.state === 'app_not_running'}
			<button class="btn btn-accent" disabled={launching} onclick={launch}>{launching ? 'Opening…' : 'Open Gloss'}</button>
		{/if}
	</div>

	{#if connected && askable}
		<section>
			<h2>This page</h2>
			{#if pageError}
				<div class="error">{pageError}</div>
			{:else if asks.length === 0}
				<div class="muted">No notes on this page yet. Highlight text and click “Ask about this”.</div>
			{:else}
				<div class="list">
					{#each asks as c (c.id)}
						<button class="item" class:is-orphan={c.anchorState === 'orphan'} onclick={() => focusAsk(c)} title={c.quote}>
							<span class="mark" style="font-size:15px">“</span>
							<span class="title">{shortQuote(c)}</span>
							{#if c.anchorState === 'orphan'}<span class="badge">not found</span>{:else if c.anchorState === 'fuzzy'}<span class="badge">approx.</span>{/if}
						</button>
					{/each}
				</div>
				{#if orphans > 0}
					<div class="muted">{orphans} {orphans === 1 ? 'note' : 'notes'} not found on this page.</div>
				{/if}
				<div class="row" style="margin-top:6px">
					<span class="spacer"></span>
					<button class="btn" onclick={openInGloss}>Open in Gloss</button>
				</div>
			{/if}
		</section>

		<section>
			<h2>Ask about this page</h2>
			<textarea
				class="textarea"
				placeholder={running ? 'Waiting for the current reply…' : 'What is this page about?'}
				bind:value={question}
				disabled={sending || running}
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void askPage();
					}
				}}
			></textarea>
			{#if askError}<div class="error">{askError}</div>{/if}
			<div class="row" style="margin-top:6px">
				{#if running}<button class="btn" onclick={cancel}>Stop</button>{/if}
				<span class="spacer"></span>
				<button class="btn btn-accent" disabled={sending || running || !question.trim()} onclick={askPage}>{sending ? 'Sending…' : 'Ask'}</button>
			</div>
			{#if reply}
				<div class="turn" style="margin-top:10px">
					<div class="turn-label">Reply</div>
					<div class="turn-text md">
						{@html renderMarkdown(reply.text)}{#if isLive(reply)}<span class="cursor"></span>{/if}
					</div>
					{#if reply.status === 'error'}<div class="error">{reply.error ?? 'The reply failed.'}</div>{/if}
					{#if reply.status === 'cancelled'}<div class="muted">Cancelled.</div>{/if}
				</div>
			{/if}
		</section>
	{:else if connected}
		<div class="muted">Gloss works on web pages. This tab cannot be asked about.</div>
	{/if}

	{#if connected && recent.length}
		<section>
			<h2>Recent pages</h2>
			<div class="list">
				{#each recent as p (p.urlKey)}
					<button class="item" onclick={() => openPage(p)} title={p.url}>
						<span class="title">{p.title || p.url}</span>
						<span class="count">{p.askCount}</span>
					</button>
				{/each}
			</div>
		</section>
	{/if}

	<div class="muted">
		Highlight text, then press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> or right-click to ask.
	</div>
</div>
