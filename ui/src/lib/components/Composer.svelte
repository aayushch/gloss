<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// Main message box at the bottom of the conversation column. Files can be
	// attached with the paperclip, by dropping them on the window, or by
	// pasting; staged files show as chips above the text until the message is
	// sent. Inside Tauri the paperclip opens the native file picker and drops
	// arrive through Tauri's drag-drop events, which give file paths: the
	// webview never sees a dropped file as an HTML drop, so the HTML handlers
	// below only serve the browser build with the mock API.
	import { api, inTauri } from '$lib/api/client';
	import { app, formatSize } from '$lib/state/app.svelte';
	import Icon from './Icon.svelte';

	let {
		disabled = false,
		running = false,
		onsend,
		onstop
	}: {
		disabled?: boolean;
		running?: boolean;
		onsend: (text: string) => void;
		onstop: () => void;
	} = $props();

	let value = $state('');
	let ta: HTMLTextAreaElement | undefined = $state();
	let picker: HTMLInputElement | undefined = $state();
	let dragging = $state(false);

	function grow(el: HTMLTextAreaElement) {
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 200) + 'px';
	}

	function send() {
		const t = value.trim();
		if (!t || disabled || running) return;
		onsend(t);
		value = '';
		if (ta) ta.style.height = 'auto';
	}

	async function pick() {
		const paths = await (await api()).pickFiles();
		if (paths === null) {
			picker?.click();
			return;
		}
		if (paths.length) app.attachPaths(paths);
	}

	function onPick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		if (input.files?.length) app.attach(input.files);
		input.value = '';
	}

	// Native drops anywhere on the window stage the files; the box lights up
	// while a drag is over the window.
	$effect(() => {
		if (!inTauri()) return;
		let unlisten: (() => void) | undefined;
		let gone = false;
		(async () => {
			const { getCurrentWebview } = await import('@tauri-apps/api/webview');
			const stop = await getCurrentWebview().onDragDropEvent((e) => {
				if (e.payload.type === 'enter' || e.payload.type === 'over') {
					dragging = !disabled && !running;
				} else if (e.payload.type === 'leave') {
					dragging = false;
				} else if (e.payload.type === 'drop') {
					dragging = false;
					if (!disabled && !running && e.payload.paths.length) app.attachPaths(e.payload.paths);
				}
			});
			if (gone) stop();
			else unlisten = stop;
		})();
		return () => {
			gone = true;
			unlisten?.();
		};
	});

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (disabled || running) return;
		if (e.dataTransfer?.files.length) app.attach(e.dataTransfer.files);
	}

	function onPaste(e: ClipboardEvent) {
		const files = [...(e.clipboardData?.files ?? [])];
		if (!files.length) return;
		e.preventDefault();
		app.attach(files);
	}
</script>

<div
	class="composer"
	class:dragging
	role="region"
	aria-label="Message composer"
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
>
	{#if app.staged.length || app.attachError}
		<div class="staged">
			{#each app.staged as att (att.id)}
				<span class="chip" title="{att.name} · {formatSize(att.size)}">
					{#if att.kind === 'image' && app.thumbs[att.id]}
						<img src={app.thumbs[att.id]} alt="" />
					{:else}
						<Icon name="file" size={12} />
					{/if}
					<span class="name">{att.name}</span>
					<button
						type="button"
						class="rm"
						title="Remove"
						aria-label="Remove {att.name}"
						onclick={() => app.unstage(att.id)}><Icon name="x" size={11} /></button
					>
				</span>
			{/each}
			{#if app.attachError}
				<span class="err">{app.attachError}</span>
			{/if}
		</div>
	{/if}
	<div class="rowbox">
		<input
			bind:this={picker}
			type="file"
			multiple
			accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.txt,.json,.csv,.xml,.yaml,.yml,.toml,.ini,.log,.rs,.ts,.js,.py,.go,.java,.c,.h,.cpp,.hpp,.cs,.rb,.sh,.sql,.html,.css,.svelte"
			hidden
			onchange={onPick}
		/>
		<button
			type="button"
			class="attach"
			title="Attach an image or text file"
			aria-label="Attach a file"
			disabled={disabled || running}
			onclick={pick}
		>
			<Icon name="paperclip" size={15} />
		</button>
		<textarea
			bind:this={ta}
			bind:value
			class="iinput"
			rows="1"
			placeholder={disabled
				? 'Pick an available agent in Settings to start'
				: running
					? 'Waiting for the reply…'
					: app.active?.pageKey
						? 'Ask about this page…'
						: 'Message the agent…'}
			disabled={disabled || running}
			oninput={(e) => grow(e.currentTarget)}
			onpaste={onPaste}
			onkeydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					send();
				}
			}}></textarea>
		{#if running}
			<button type="button" class="ibtn pill stop" onclick={onstop} title="Stop the agent">
				<Icon name="square" size={12} /> Stop
			</button>
		{:else}
			<button
				type="button"
				class="ibtn primary pill send"
				onclick={send}
				disabled={disabled || !value.trim()}>Send</button
			>
		{/if}
	</div>
</div>

<style>
	.composer {
		padding: 8px 16px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 2px solid transparent;
		transition: border-color 120ms ease;
	}
	.composer.dragging {
		border-top-color: var(--accent);
	}
	.rowbox {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}
	textarea {
		border-radius: 18px;
		padding: 8px 14px;
		min-height: 36px;
		max-height: 200px;
		resize: none;
		line-height: 1.4;
	}
	.attach {
		width: 36px;
		height: 36px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		color: var(--text-3);
	}
	.attach:hover:not(:disabled) {
		background: var(--surface-2);
		color: var(--text);
	}
	.attach:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.send,
	.stop {
		height: 36px;
		padding: 0 16px;
		flex: none;
	}
	.staged {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding-left: 44px;
		align-items: center;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 4px 3px 8px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--surface);
		font-size: 12px;
		color: var(--text-2);
		max-width: 280px;
	}
	.chip img {
		width: 22px;
		height: 22px;
		object-fit: cover;
		border-radius: 4px;
	}
	.chip .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rm {
		display: inline-flex;
		padding: 3px;
		border-radius: 4px;
		color: var(--text-3);
	}
	.rm:hover {
		color: var(--accent-text);
		background: var(--surface-2);
	}
	.err {
		font-size: 12px;
		color: var(--accent-text);
	}
</style>
