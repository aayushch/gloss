<script lang="ts">
	// The standalone ask window, used where no content script runs (PDF
	// viewer, browser pages). It asks about raw selection text, so the ask
	// gets a quote-only anchor and is an orphan on the page by design.
	//
	// Such pages cannot show a note beside its passage, so the window also
	// lists the page's notes and steps through them with ‹ and ›. It opens
	// on a new question (the URL carries `text`, or nothing for a question
	// about the whole page) or on an existing note (`focus`).
	import { onDestroy, onMount } from 'svelte';
	import { connectClient, type Client } from '../shared/client';
	import { MARK_SVG } from '../shared/mark';
	import type { ConnectionStatus } from '../shared/messages';
	import {
		DEFAULT_SETTINGS,
		failureOf,
		type Clarification,
		type FollowUpResult,
		type GetPageResult,
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
	const focus = params.get('focus');

	const PRESETS = [
		{ label: 'Explain', text: 'Explain this.' },
		{ label: 'Why?', text: 'Why is this the case?' },
		{ label: 'Example', text: 'Give me a concrete example of this.' },
		{ label: 'Translate', text: 'Translate this into English.' },
	];

	/** The view of the new question, as opposed to an existing note's id. */
	const NEW = 'new';

	interface Note {
		clarification: Clarification;
		turns: Turn[];
	}

	let client: Client;
	let status = $state<ConnectionStatus>({ state: 'connecting', settings: DEFAULT_SETTINGS });
	let text = $state('');
	/** The page's notes, oldest first. */
	let notes = $state<Note[]>([]);
	let urlKey = $state<string | null>(null);
	/** True while the window holds a new question that has not become a note. */
	let draft = $state(!focus);
	/** What the window shows: `NEW` or a note's id. */
	let view = $state<string>(focus ?? NEW);
	/** Turns of the new question; a question about the whole page stays here, as it makes no note. */
	let draftTurns = $state<Turn[]>([]);
	let result = $state<PageAskResult | null>(null);
	let error = $state<string | null>(null);
	let sending = $state(false);
	let appDown = $state(false);
	let launching = $state(false);
	let textarea: HTMLTextAreaElement | undefined = $state();

	const askable = $derived(/^(https?|file):/.test(pageUrl));
	const views = $derived([...notes.map((n) => n.clarification.id), ...(draft ? [NEW] : [])]);
	const note = $derived(view === NEW ? null : (notes.find((n) => n.clarification.id === view) ?? null));
	const turns = $derived(note ? note.turns : draftTurns);
	const quote = $derived(note ? note.clarification.quote : selection);
	const running = $derived(turns.length > 0 && isLive(turns[turns.length - 1]));
	const position = $derived(note ? notes.indexOf(note) : -1);

	onMount(async () => {
		client = connectClient();
		client.onEvent((event, data) => {
			if (event === 'connection') {
				const was = status.state;
				status = data as ConnectionStatus;
				if (status.state === 'connected' && was !== 'connected') void loadNotes();
			} else if (event === 'turn') {
				const env = data as TurnEventEnvelope;
				draftTurns = draftTurns.map((t) => applyToTurn(t, env));
				notes = notes.map((n) => (n.turns.some((t) => t.id === env.turnId) ? { ...n, turns: n.turns.map((t) => applyToTurn(t, env)) } : n));
			} else if (event === 'page') {
				void loadNotes();
			} else if (event === 'app_state' && (data as { running: boolean }).running) {
				launching = false;
				void loadNotes();
				if (appDown && text.trim()) void send();
			}
		});
		status = await client.status();
		await loadNotes();
		textarea?.focus();
	});
	onDestroy(() => client?.close());

	/** Fetches the page's notes from Gloss and follows their replies. */
	async function loadNotes() {
		if (!askable || status.state !== 'connected') return;
		let page: GetPageResult;
		try {
			page = await client.request<GetPageResult>('getPage', { url: pageUrl, title: pageTitle });
		} catch {
			return;
		}
		urlKey = page.urlKey;
		// A page Gloss has not stored yet has no notes and no conversation to follow.
		if (!page.page) {
			notes = [];
			if (!views.includes(view)) view = views[0] ?? NEW;
			return;
		}
		const { conversation } = page.page;
		notes = conversation.clarifications
			.filter((c) => c.webAnchor)
			.sort((a, b) => a.number - b.number || a.createdAt - b.createdAt)
			.map((c) => ({
				clarification: c,
				turns: conversation.turns.filter((t) => t.clarificationId === c.id).sort((a, b) => a.seq - b.seq),
			}));
		client.subscribe({ urlKey: page.urlKey, conversationId: conversation.id });
		// A note that was removed meanwhile, or a `focus` id that is not on this page.
		if (!views.includes(view)) view = views[0] ?? NEW;
	}

	/** Shows the view `delta` places away in `views`, wrapping at either end. */
	function step(delta: 1 | -1) {
		if (views.length < 2) return;
		const i = views.indexOf(view);
		view = views[(i + delta + views.length) % views.length];
		error = null;
	}

	async function send() {
		const q = text.trim();
		if (!q || sending || running) return;
		sending = true;
		error = null;
		try {
			if (note) {
				const r = await client.request<FollowUpResult>('followUp', { clarificationId: note.clarification.id, question: q });
				const id = note.clarification.id;
				notes = notes.map((n) => (n.clarification.id === id ? { ...n, turns: [...n.turns, r.userTurn, r.assistantTurn] } : n));
			} else if (!result) {
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
				urlKey = r.urlKey;
				client.subscribe({ urlKey: r.urlKey, conversationId: r.conversationId });
				if (r.clarification) {
					// The question became a note: it joins the list and the window shows it there.
					notes = [...notes.filter((n) => n.clarification.id !== r.clarification!.id), { clarification: r.clarification, turns: [r.userTurn, r.assistantTurn] }];
					draft = false;
					view = r.clarification.id;
				} else {
					draftTurns = [r.userTurn, r.assistantTurn];
				}
			} else {
				const r = await client.request<PageAskResult>('askPage', { page: { url: pageUrl, title: pageTitle }, anchor: null, context: { before: '', after: '' }, question: q, pageText: null, private: false });
				draftTurns = [...draftTurns, r.userTurn, r.assistantTurn];
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
		const conversationId = note?.clarification.conversationId ?? result?.conversationId;
		if (conversationId) client.request('cancel', { conversationId }).catch(() => {});
	}

	function openInGloss() {
		const key = urlKey ?? result?.urlKey;
		if (!key) return;
		client.request('openInGloss', { urlKey: key, clarificationId: note?.clarification.id ?? null }).catch(() => launch());
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		} else if (e.key === 'Escape' && !text.trim()) {
			window.close();
		}
	}

	/** ← and → step through the notes while the question box is not being typed in. */
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLTextAreaElement || e.altKey || e.ctrlKey || e.metaKey) return;
		if (e.key === 'ArrowLeft') step(-1);
		else if (e.key === 'ArrowRight') step(1);
		else if (e.key === 'Escape') window.close();
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="page">
	<h1><span class="mark">{@html MARK_SVG}</span> Ask Gloss</h1>
	{#if pageTitle || pageUrl}
		<div class="muted" title={pageUrl}>{pageTitle || pageUrl}</div>
	{/if}

	{#if views.length > 1 || (notes.length > 0 && !draft)}
		<div class="note-nav" role="toolbar" aria-label="Notes on this page">
			<button class="btn note-step" title="Previous note (←)" aria-label="Previous note" disabled={views.length < 2} onclick={() => step(-1)}>‹</button>
			<span class="note-pos">
				{#if note}
					Note {position + 1} of {notes.length}
				{:else}
					New question · {notes.length} {notes.length === 1 ? 'note' : 'notes'}
				{/if}
			</span>
			<button class="btn note-step" title="Next note (→)" aria-label="Next note" disabled={views.length < 2} onclick={() => step(1)}>›</button>
		</div>
	{/if}

	{#if quote}
		<div class="quote">{quote}</div>
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
						{#if turn.truncated}<div class="muted">Shortened here; the full reply is in Gloss.</div>{/if}
					{/if}
				</div>
			{/each}
		</div>
	{:else if !note}
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
		{#if note || result}<button class="btn" onclick={openInGloss}>Open in Gloss</button>{/if}
		<button class="btn btn-accent" disabled={sending || running || !text.trim()} onclick={send}>{sending ? 'Sending…' : 'Ask'}</button>
	</div>
</div>
