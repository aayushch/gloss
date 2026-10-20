<script lang="ts">
	import { innerWidth, innerHeight } from 'svelte/reactivity/window';
	import { renderMarkdown } from '../markdown';
	import { isStreaming } from '../state';
	import type { Actions } from './actions';
	import type { UiStore } from './store.svelte';

	let { store, actions }: { store: UiStore; actions: Actions } = $props();

	// The page state mutates its ask entries in place and ticks `version`.
	// A fresh copy on every tick gives the template a value that changed,
	// so it re-renders streamed text; the entry object itself never changes.
	const entry = $derived.by(() => {
		store.version;
		const e = store.popover ? store.page.asks.get(store.popover.askId) : null;
		return e ? { ...e } : null;
	});
	const askId = $derived(store.popover?.askId ?? '');
	const streaming = $derived(entry ? isStreaming(entry) : false);
	const running = $derived.by(() => {
		store.version;
		return store.page.running;
	});
	const appDown = $derived(store.connection.state === 'app_not_running' || store.connection.state === 'host_missing');

	let height = $state(0);
	let thread: HTMLDivElement | undefined = $state();
	let text = $state('');
	/** True while the footer asks to confirm removing the note. */
	let confirmRemove = $state(false);
	const WIDTH = 420;

	const style = $derived.by(() => {
		const vw = innerWidth.current ?? 1024;
		const vh = innerHeight.current ?? 768;
		const width = Math.min(WIDTH, vw - 32);
		const rect = store.anchorRect;
		if (!rect) {
			return `left:${Math.round((vw - width) / 2)}px; top:72px; width:${width}px`;
		}
		const left = Math.min(Math.max(16, rect.right - width / 2), vw - width - 16);
		let top = rect.bottom + 8;
		if (top + height > vh - 16 && rect.top - 8 - height > 16) top = rect.top - 8 - height;
		top = Math.max(8, Math.min(top, vh - 8 - Math.min(height, vh - 16)));
		return `left:${Math.round(left)}px; top:${Math.round(top)}px; width:${width}px`;
	});

	const quote = $derived.by(() => {
		const q = entry?.clarification.quote ?? '';
		return q.length > 90 ? q.slice(0, 90) + '…' : q;
	});

	// The thread follows new text while a reply streams in.
	$effect(() => {
		if (streaming && entry && thread) {
			entry.turns.length;
			entry.turns[entry.turns.length - 1]?.text;
			thread.scrollTop = thread.scrollHeight;
		}
	});

	// Switching to another note drops a pending confirmation.
	$effect(() => {
		askId;
		confirmRemove = false;
	});

	function submit() {
		const t = text.trim();
		if (!t || running || !entry) return;
		actions.followUp(askId, t);
		text = '';
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			actions.closePopover();
		}
	}
</script>

{#if entry}
	<div class="gloss-card gloss-popover" {style} bind:clientHeight={height} role="dialog" aria-label="Gloss note">
		<div class="gloss-popover-head">
			<span class="gloss-mark">“</span>
			<span class="gloss-popover-quote" title={entry.clarification.quote}>{quote}</span>
			{#if entry.state === 'fuzzy'}<span class="gloss-badge" title="The passage changed since you asked; this is the closest match">approximate</span>{/if}
			{#if entry.state === 'orphan'}<span class="gloss-badge" title="The passage is no longer on this page">not on page</span>{/if}
			<button type="button" class="gloss-icon-btn" title="Collapse: the note stays, its mark dims" aria-label="Collapse" onclick={() => actions.collapse(askId)}>–</button>
			<button type="button" class="gloss-icon-btn" title="Close" aria-label="Close" onclick={() => actions.closePopover()}>×</button>
		</div>
		<div class="gloss-thread" bind:this={thread}>
			{#each entry.turns as turn (turn.id)}
				<div class="gloss-turn" class:is-user={turn.role === 'user'}>
					<div class="gloss-turn-label">{turn.role === 'user' ? 'You' : 'Reply'}</div>
					{#if turn.role === 'user'}
						<div class="gloss-turn-text">{turn.text}</div>
					{:else}
						<div class="gloss-turn-text gloss-md">
							{@html renderMarkdown(turn.text)}{#if turn.status === 'pending' || turn.status === 'streaming'}<span class="gloss-cursor"></span>{/if}
						</div>
						{#if turn.status === 'error'}<div class="gloss-error">{turn.error ?? 'The reply failed.'}</div>{/if}
						{#if turn.status === 'cancelled'}<div class="gloss-hint">Cancelled.</div>{/if}
						{#if turn.truncated}<div class="gloss-hint">Shortened here; the full reply is in Gloss.</div>{/if}
					{/if}
				</div>
			{/each}
		</div>
		<div class="gloss-followup">
			<textarea
				class="gloss-textarea"
				rows="1"
				placeholder={running ? 'Waiting for the reply…' : 'Follow up…'}
				bind:value={text}
				disabled={running}
				{onkeydown}
			></textarea>
		</div>
		<div class="gloss-row gloss-popover-actions">
			{#if streaming || running}
				<button type="button" class="gloss-btn" onclick={() => actions.cancel(askId)}>Stop</button>
			{:else if confirmRemove}
				<span class="gloss-hint">Remove this note from the page and from Gloss?</span>
				<button type="button" class="gloss-btn gloss-btn-danger" onclick={() => actions.remove(askId)}>Remove</button>
				<button type="button" class="gloss-btn" onclick={() => (confirmRemove = false)}>Keep</button>
			{:else}
				<button type="button" class="gloss-btn gloss-btn-quiet" onclick={() => (confirmRemove = true)}>Remove…</button>
			{/if}
			<span class="gloss-spacer"></span>
			<button type="button" class="gloss-btn" onclick={() => actions.openInGloss(askId)}>
				{appDown ? 'Open Gloss' : 'Open in Gloss'}
			</button>
		</div>
	</div>
{/if}
