<script lang="ts">
	// The standalone ask window, used where no content script runs (PDF
	// viewer, browser pages). It asks about raw selection text, so the ask
	// gets a quote-only anchor and is an orphan on the page by design.
	import { onDestroy, onMount } from 'svelte';
	import { connectClient, type Client } from '../shared/client';
	import type { ConnectionStatus } from '../shared/messages';
	import {
		DEFAULT_SETTINGS,
		failureOf,
		type FollowUpResult,
		type PageAskRequest,
		type PageAskResult,
		type Turn,
		type TurnEventEnvelope,
	} from '../shared/protocol';
	import { applyToTurn, isLive } from '../shared/reply';
	import { renderMarkdown } from '../content/markdown';

	const params = new URLSearchParams(location.search);
	const pageUrl = params.get('url') ?? '';
	const pageTitle = params.get('title') ?? '';
	const selection = (params.get('text') ?? '').replace(/\s+/g, ' ').trim();

	const PRESETS = [
		{ label: 'Explain', text: 'Explain this.' },
		{ label: 'Why?', text: 'Why is this the case?' },
		{ label: 'Example', text: 'Give me a concrete example of this.' },
		{ label: 'Translate', text: 'Translate this into English.' },
	];

	let client: Client;
	let status = $state<ConnectionStatus>({ state: 'connecting', settings: DEFAULT_SETTINGS });
	let text = $state('');
	let turns = $state<Turn[]>([]);
	let result = $state<PageAskResult | null>(null);
	let error = $state<string | null>(null);
	let sending = $state(false);
	let appDown = $state(false);
	let launching = $state(false);
	let textarea: HTMLTextAreaElement | undefined = $state();

	const running = $derived(turns.length > 0 && isLive(turns[turns.length - 1]));
	const askable = $derived(/^(https?|file):/.test(pageUrl));

	onMount(async () => {
		client = connectClient();
		client.onEvent((event, data) => {
			if (event === 'connection') status = data as ConnectionStatus;
			else if (event === 'turn') turns = turns.map((t) => applyToTurn(t, data as TurnEventEnvelope));
			else if (event === 'app_state' && (data as { running: boolean }).running) {
				launching = false;
				if (appDown && text.trim()) void send();
			}
		});
		status = await client.status();
		textarea?.focus();
	});
	onDestroy(() => client?.close());

	async function send() {
		const q = text.trim();
		if (!q || sending || running) return;
		sending = true;
		error = null;
		try {
			if (!result) {
				const payload: PageAskRequest = {
					page: { url: pageUrl, title: pageTitle },
					anchor: selection ? { quote: { exact: selection, prefix: '', suffix: '' }, position: null, container: null } : null,
					context: { before: '', after: '' },
					question: q,
					pageText: null,
					private: false,
				};
				const r = await client.request<PageAskResult>(selection ? 'ask' : 'askPage', payload);
				result = r;
				turns = [r.userTurn, r.assistantTurn];
				client.subscribe({ urlKey: r.urlKey, conversationId: r.conversationId });
			} else if (result.clarification) {
				const r = await client.request<FollowUpResult>('followUp', { clarificationId: result.clarification.id, question: q });
				turns = [...turns, r.userTurn, r.assistantTurn];
			} else {
				const r = await client.request<PageAskResult>('askPage', { page: { url: pageUrl, title: pageTitle }, anchor: null, context: { before: '', after: '' }, question: q, pageText: null, private: false });
				turns = [...turns, r.userTurn, r.assistantTurn];
			}
			appDown = false;
			text = '';
		} catch (e) {
			const f = failureOf(e);
			if (f.code === 'app_not_running') appDown = true;
			else error = f.code === 'busy' ? 'Gloss is still answering another question on this page.' : f.message;
		} finally {
			sending = false;
		}
	}

	function launch() {
		launching = true;
		client.request('launchApp', {}).catch((e) => {
			launching = false;
			error = failureOf(e).message;
		});
	}

	function cancel() {
		if (result) client.request('cancel', { conversationId: result.conversationId }).catch(() => {});
	}

	function openInGloss() {
		if (!result) return;
		client.request('openInGloss', { urlKey: result.urlKey, clarificationId: result.clarification?.id ?? null }).catch(() => launch());
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		} else if (e.key === 'Escape' && !result) {
			window.close();
		}
	}
</script>

<div class="page">
	<h1><span class="mark">“</span> Ask Gloss</h1>
	{#if pageTitle || pageUrl}
		<div class="muted" title={pageUrl}>{pageTitle || pageUrl}</div>
	{/if}
	{#if selection}
		<div class="quote">{selection}</div>
	{/if}

	{#if !askable}
		<div class="notice">Gloss cannot keep notes on this kind of page, but the question is sent with the text above.</div>
	{/if}

	{#if status.state === 'protocol_mismatch'}
		<div class="notice">{status.mismatch === 'update_app' ? 'Update Gloss to use the extension.' : 'Update the Gloss extension.'}</div>
	{:else if appDown || status.state === 'app_not_running'}
		<div class="notice">
			<span>Gloss isn't running.</span>
			<button class="btn btn-accent" disabled={launching} onclick={launch}>{launching ? 'Opening…' : 'Open Gloss'}</button>
		</div>
	{/if}

	{#if turns.length}
		<div class="thread">
			{#each turns as turn (turn.id)}
				<div class="turn" class:is-user={turn.role === 'user'}>
					<div class="turn-label">{turn.role === 'user' ? 'You' : 'Reply'}</div>
					{#if turn.role === 'user'}
						<div class="turn-text">{turn.text}</div>
					{:else}
						<div class="turn-text md">{@html renderMarkdown(turn.text)}{#if isLive(turn)}<span class="cursor"></span>{/if}</div>
						{#if turn.status === 'error'}<div class="error">{turn.error ?? 'The reply failed.'}</div>{/if}
						{#if turn.status === 'cancelled'}<div class="muted">Cancelled.</div>{/if}
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="chips">
			{#each PRESETS as p (p.label)}
				<button class="chip" onclick={() => { text = p.text; textarea?.focus(); }}>{p.label}</button>
			{/each}
		</div>
	{/if}

	<textarea
		bind:this={textarea}
		class="textarea"
		placeholder={turns.length ? 'Follow up…' : 'Ask about this…'}
		bind:value={text}
		disabled={sending || running}
		{onkeydown}
	></textarea>
	{#if error}<div class="error">{error}</div>{/if}
	<div class="row">
		<span class="muted">Enter to send</span>
		<span class="spacer"></span>
		{#if running}<button class="btn" onclick={cancel}>Stop</button>{/if}
		{#if result}<button class="btn" onclick={openInGloss}>Open in Gloss</button>{/if}
		<button class="btn btn-accent" disabled={sending || running || !text.trim()} onclick={send}>{sending ? 'Sending…' : 'Ask'}</button>
	</div>
</div>
