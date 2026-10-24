<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Scrolling transcript. Owns text-selection handling (the floating "Ask
	// about this" button), scroll-to-well jumps and auto-scroll on new turns.
	import type { Turn } from '$lib/api/types';
	import { app, AGENT_NAMES, ORIGIN_LABELS } from '$lib/state/app.svelte';
	import { find } from '$lib/state/find.svelte';
	import { blockRegistry, buildThreads, relativeTime } from '$lib/state/threads';

	/** A session written to this recently may still be open where it started. */
	const RECENT_MS = 10 * 60_000;
	import AskButton from './AskButton.svelte';
	import AssistantTurn from './AssistantTurn.svelte';
	import PageTranscript from './PageTranscript.svelte';
	import SessionTurns from './SessionTurns.svelte';
	import UserBubble from './UserBubble.svelte';

	let container: HTMLDivElement | undefined = $state();

	const conv = $derived(app.active);
	const threads = $derived(conv ? buildThreads(conv) : new Map());
	const mainTurns = $derived((conv?.turns ?? []).filter((t) => !t.clarificationId));

	/** The user turn that produced an assistant turn, for the retry button. */
	function userBefore(turns: Turn[], i: number): Turn | undefined {
		for (let j = i - 1; j >= 0; j--) if (turns[j].role === 'user') return turns[j];
		return undefined;
	}

	function flat(s: string): string {
		return s.replace(/\s+/g, ' ').trim();
	}

	function elementOf(n: Node | null): HTMLElement | null {
		if (!n) return null;
		return n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as HTMLElement);
	}

	function onMouseUp(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('[data-ask]')) return;
		if (!container) return;
		const sel = window.getSelection();
		const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
		if (!text || text.length < 3) {
			app.pendingAsk = null;
			return;
		}
		const a = elementOf(sel!.anchorNode)?.closest<HTMLElement>('[data-block]');
		const f = elementOf(sel!.focusNode)?.closest<HTMLElement>('[data-block]');
		if (!a || a !== f) {
			app.pendingAsk = null;
			return;
		}
		const blockId = a.dataset.block!;
		const reg = blockRegistry.get(blockId);
		// The selection must come from the block's own text. Whitespace is
		// collapsed on both sides because a selection across code lines or
		// table cells picks up newlines and tabs the block text does not have,
		// and a table's text joins its cells with " | " which the DOM lacks.
		const haystack = reg
			? flat(reg.kind === 'table' ? reg.text.replace(/ \| /g, ' ') : reg.text)
			: '';
		if (!reg || !haystack.includes(flat(text))) {
			app.pendingAsk = null;
			return;
		}
		const r = sel!.getRangeAt(0).getBoundingClientRect();
		const c = container.getBoundingClientRect();
		const x = Math.min(Math.max(r.left - c.left + r.width / 2, 70), c.width - 70);
		const y = r.top - c.top + container.scrollTop - 44;
		app.pendingAsk = { blockId, quote: text, x, y };
	}

	function openComposer() {
		const ask = app.pendingAsk;
		if (!ask) return;
		window.getSelection()?.removeAllRanges();
		const reg = blockRegistry.get(ask.blockId);
		app.composerFor = { blockId: ask.blockId, quote: ask.quote, parentId: reg?.parentId ?? null };
		app.pendingAsk = null;
	}

	$effect(() => {
		const onDown = (e: MouseEvent) => {
			if (!(e.target as HTMLElement).closest('[data-ask]')) app.pendingAsk = null;
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	});

	// The find bar searches whatever this container renders.
	$effect(() => {
		find.attach(container ?? null);
		return () => find.attach(null);
	});

	// Jump to a well or turn when a stub or rail item asks for it. The target
	// may still be rendering (a well that was just opened, a conversation that
	// was just loaded), so the lookup is retried for up to a second.
	$effect(() => {
		const target = app.jumpTarget;
		if (!target || !container) return;
		const el = container;
		const deadline = Date.now() + 1000;
		const attempt = () => {
			const node = document.getElementById(target);
			if (!node && Date.now() < deadline) {
				requestAnimationFrame(attempt);
				return;
			}
			if (node) {
				const top =
					node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 80;
				el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
			}
			if (app.jumpTarget === target) app.jumpTarget = null;
		};
		requestAnimationFrame(attempt);
	});

	// Scroll to the top when switching conversations and to the bottom when a
	// new main-column turn appears.
	let lastConv = '';
	let lastCount = 0;
	$effect(() => {
		const id = conv?.id ?? '';
		const n = mainTurns.length;
		if (!container) return;
		const el = container;
		if (id !== lastConv) {
			lastConv = id;
			lastCount = n;
			el.scrollTop = 0;
			return;
		}
		if (n > lastCount) {
			lastCount = n;
			setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 30);
		}
	});
</script>

<div class="transcript" bind:this={container} onmouseup={onMouseUp} role="presentation">
	{#if conv?.pageKey}
		<PageTranscript {conv} {threads} />
	{:else if conv}
		{#if app.earlier.length}
			<SessionTurns turns={app.earlier} />
			<div class="handover"><span>Continued in Gloss</span></div>
		{/if}
		{#each mainTurns as t, i (t.id)}
			{#if t.role === 'user'}
				<UserBubble turn={t} />
			{:else}
				<AssistantTurn turn={t} userTurn={userBefore(mainTurns, i)} {conv} {threads} />
			{/if}
		{/each}
		{#if conv.turns.length === 0 && !app.earlier.length}
			<div class="empty">
				Send a message to start. Select any part of a reply to ask about it inline.
			</div>
		{/if}
	{:else if app.viewing}
		{@const v = app.viewing}
		{@const recent = Date.now() - v.session.updatedAt < RECENT_MS}
		<div class="note" class:warn={recent}>
			{AGENT_NAMES[v.session.agent]} session run {v.session.origin
				? ORIGIN_LABELS[v.session.origin]
				: 'outside Gloss'}, last written {relativeTime(v.session.updatedAt)}. Send a message below
			to continue it here: Gloss resumes the same session, so it stays in {AGENT_NAMES[
				v.session.agent
			]}'s own history too. It continues read-only until you pick another mode in the header.
			{#if recent}
				<strong
					>It was written to in the last few minutes. If it is still open in a terminal or editor,
					close it there first: both would write to the same session.</strong
				>
			{/if}
		</div>
		{#if v.turns === null}
			<div class="empty">Reading the session…</div>
		{:else if !v.turns.length}
			<div class="empty">This session has no turns Gloss can show.</div>
		{:else}
			<SessionTurns turns={v.turns} />
		{/if}
	{:else if app.draft}
		<div class="empty">
			<div class="big">New conversation</div>
			<div>
				Via {app.activeAgent?.name ?? app.draft.agent}{app.activeModelId
					? ` · ${app.modelName(app.draft.agent, app.activeModelId)}`
					: ''}. Select any part of a reply to ask about it inline.
			</div>
			{#if app.draft.projectDir}
				<div>
					The agent runs inside <strong>{app.draft.projectDir}</strong> and can read its files, not change
					them.
				</div>
			{:else}
				<div>Pick a project in the header to let the agent read one of your folders.</div>
			{/if}
		</div>
	{:else if app.loadError}
		<div class="empty error">Could not reach the engine: {app.loadError}</div>
	{/if}
	{#if app.pendingAsk}
		<AskButton
			x={app.pendingAsk.x}
			y={app.pendingAsk.y}
			disabled={app.running}
			onask={openComposer}
		/>
	{/if}
</div>

<style>
	.transcript {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 20px 28px 32px;
		position: relative;
	}
	.empty {
		color: var(--text-3);
		font-size: 13.5px;
		padding: 48px 0;
		text-align: center;
		max-width: 420px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.big {
		font-size: 17px;
		font-weight: 600;
		color: var(--text-2);
	}
	.error {
		color: var(--accent-text);
	}
	.note {
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-2);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 10px 14px;
		margin: 0 0 22px;
		max-width: 720px;
	}
	.note.warn {
		border-color: var(--accent);
	}
	.note strong {
		display: block;
		margin-top: 6px;
		color: var(--accent-text);
		font-weight: 500;
	}
	.handover {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 4px 0 22px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
	}
	.handover::before,
	.handover::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--line);
	}
</style>
