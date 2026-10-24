<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import { innerWidth, innerHeight } from 'svelte/reactivity/window';
	import type { ConnectionStatus } from '../../shared/messages';
	import type { Actions } from './actions';
	import type { ComposerState } from './store.svelte';

	let {
		composer,
		connection,
		running,
		actions
	}: { composer: ComposerState; connection: ConnectionStatus; running: boolean; actions: Actions } =
		$props();

	const PRESETS: { label: string; text: string }[] = [
		{ label: 'Explain', text: 'Explain this.' },
		{ label: 'Why?', text: 'Why is this the case?' },
		{ label: 'Example', text: 'Give me a concrete example of this.' },
		{ label: 'Translate', text: 'Translate this into English.' }
	];

	let textarea: HTMLTextAreaElement | undefined = $state();
	let height = $state(0);
	const WIDTH = 360;

	const style = $derived.by(() => {
		const vw = innerWidth.current ?? 1024;
		const vh = innerHeight.current ?? 768;
		const width = Math.min(WIDTH, vw - 32);
		const left = Math.min(Math.max(16, composer.rect.left), vw - width - 16);
		let top = composer.rect.bottom + 10;
		if (top + height > vh - 16 && composer.rect.top - 10 - height > 16)
			top = composer.rect.top - 10 - height;
		return `left:${Math.round(left)}px; top:${Math.round(top)}px; width:${width}px`;
	});

	const busy = $derived(composer.phase === 'sending' || composer.phase === 'launching');
	const mismatch = $derived(connection.state === 'protocol_mismatch' ? connection.mismatch : null);
	const shortQuote = $derived(
		composer.quote.length > 140 ? composer.quote.slice(0, 140) + '…' : composer.quote
	);

	// Focus the box when it appears, and again on the next frames when the
	// page pulled focus away in the meantime (a dialog's focus trap does so
	// in a deferred step).
	$effect(() => {
		const box = textarea;
		if (!box) return;
		let tries = 0;
		let frame = 0;
		const claim = () => {
			const root = box.getRootNode() as ShadowRoot | Document;
			if (root.activeElement !== box) box.focus();
			if (++tries < 4) frame = requestAnimationFrame(claim);
		};
		claim();
		return () => cancelAnimationFrame(frame);
	});

	function submit() {
		const text = composer.text.trim();
		if (!text || busy || running) return;
		actions.send(text);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			actions.cancelComposer();
		}
	}

	function preset(text: string) {
		composer.text = text;
		textarea?.focus();
	}
</script>

<div
	class="gloss-card gloss-composer"
	{style}
	bind:clientHeight={height}
	role="dialog"
	aria-label="Ask Gloss"
>
	<div class="gloss-quote" title={composer.quote}>{shortQuote}</div>
	{#if mismatch}
		<div class="gloss-notice">
			{mismatch === 'update_app'
				? 'Update Gloss to use the extension.'
				: 'Update the Gloss extension to talk to this version of Gloss.'}
		</div>
	{:else if composer.phase === 'app_down' || composer.phase === 'launching'}
		<div class="gloss-notice">
			<span>Gloss isn't running.</span>
			<button
				type="button"
				class="gloss-btn gloss-btn-accent"
				disabled={composer.phase === 'launching'}
				onclick={actions.launchApp}
			>
				{composer.phase === 'launching' ? 'Opening…' : 'Open Gloss'}
			</button>
		</div>
		{#if composer.error}<div class="gloss-error">{composer.error}</div>{/if}
	{:else if running}
		<div class="gloss-notice">Wait for the current reply to finish before asking again.</div>
	{/if}
	<div class="gloss-chips">
		{#each PRESETS as p (p.label)}
			<button type="button" class="gloss-chip" disabled={busy} onclick={() => preset(p.text)}
				>{p.label}</button
			>
		{/each}
	</div>
	<textarea
		bind:this={textarea}
		bind:value={composer.text}
		class="gloss-textarea"
		rows="2"
		placeholder="Ask about this…"
		disabled={busy}
		{onkeydown}></textarea>
	{#if composer.error && composer.phase === 'idle'}
		<div class="gloss-error">{composer.error}</div>
	{/if}
	<div class="gloss-row">
		<span class="gloss-hint">Enter to send, Esc to cancel</span>
		<span class="gloss-spacer"></span>
		<button type="button" class="gloss-btn" onclick={actions.cancelComposer}>Cancel</button>
		<button
			type="button"
			class="gloss-btn gloss-btn-accent"
			disabled={busy || running || !composer.text.trim()}
			onclick={submit}
		>
			{composer.phase === 'sending' ? 'Sending…' : 'Ask'}
		</button>
	</div>
</div>
