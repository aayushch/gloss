<script lang="ts">
	// Fenced code with a language header and highlighted tokens. A code block
	// never shows an in-text mark; when a clarification is anchored to it the
	// header says so instead. The header's copy button puts the raw code on
	// the clipboard and shows "Copied" for a moment.
	//
	// Highlighting runs at most once per interval. Code that changes between
	// passes keeps the colours its unchanged lines already have and shows the
	// new or changed lines plain, so a block streaming in stays readable
	// without re-tokenising the whole text on every chunk.
	import { onDestroy, untrack } from 'svelte';
	import { highlightLines, mergeLines, supportsLang, type Token } from '$lib/markdown/highlight';
	import { copyText } from '$lib/clipboard';
	import Icon from './Icon.svelte';

	/** Shortest gap between two highlight passes over the same block. A pass
	 * over a few hundred lines costs tens of milliseconds on the main
	 * thread, so streamed code is re-coloured a few times a second at most. */
	const HIGHLIGHT_INTERVAL_MS = 300;

	let {
		code,
		lang,
		clarified = false,
		nested = false
	}: { code: string; lang: string; clarified?: boolean; nested?: boolean } = $props();

	let lines = $state<Token[][]>([]);
	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	/** The code and language most recently handed in; a pass that ends with
	 * older code merges its result over these and schedules another. */
	let latestCode = '';
	let latestLang = '';
	let passTimer: ReturnType<typeof setTimeout> | undefined;
	let passRunning = false;
	let lastPassAt = 0;
	let alive = true;

	async function copy(): Promise<void> {
		const ok = await copyText(code);
		if (!ok) return;
		copied = true;
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied = false), 1500);
	}

	function schedulePass(): void {
		if (passTimer !== undefined || passRunning) return;
		const wait = Math.max(0, lastPassAt + HIGHLIGHT_INTERVAL_MS - Date.now());
		passTimer = setTimeout(() => {
			passTimer = undefined;
			void runPass();
		}, wait);
	}

	async function runPass(): Promise<void> {
		const c = latestCode;
		const l = latestLang;
		passRunning = true;
		lastPassAt = Date.now();
		const res = await highlightLines(c, l);
		passRunning = false;
		if (!alive) return;
		if (latestCode === c) {
			lines = res;
			return;
		}
		lines = mergeLines(res, latestCode);
		if (supportsLang(latestLang)) schedulePass();
	}

	$effect(() => {
		latestCode = code;
		latestLang = lang;
		lines = mergeLines(untrack(() => lines), code);
		if (supportsLang(lang)) schedulePass();
	});

	onDestroy(() => {
		alive = false;
		clearTimeout(passTimer);
	});
</script>

<div class="code" class:nested>
	<div class="head">
		<span class="lang">{lang || 'text'}</span>
		<span class="tools">
			{#if clarified}
				<span class="clarified"><span class="dot"></span>clarified below</span>
			{/if}
			<button type="button" class="copy" class:copied title="Copy code" aria-label="Copy code" onclick={copy}>
				<Icon name={copied ? 'check' : 'copy'} size={12} />
				<span class="label">{copied ? 'Copied' : 'Copy'}</span>
			</button>
		</span>
	</div>
	<pre><code>{#each lines as line, i (i)}<span class="line">{#each line as tok, j (j)}{#if tok.cls}<span class={tok.cls}>{tok.t}</span>{:else}{tok.t}{/if}{/each}</span>{#if i < lines.length - 1}{'\n'}{/if}{/each}</code></pre>
</div>

<style>
	.code {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
		margin: 10px 0;
	}
	.code.nested {
		background: var(--surface-2);
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 12px;
		border-bottom: 1px solid var(--line);
		font-size: 11px;
		color: var(--text-3);
	}
	.lang {
		font-family: var(--mono);
	}
	.tools {
		display: inline-flex;
		align-items: center;
		gap: 10px;
	}
	.copy {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 6px;
		margin: -2px -6px -2px 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-3);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
	}
	.code:hover .copy,
	.copy:focus-visible,
	.copy.copied {
		opacity: 1;
	}
	.copy:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.copy.copied {
		color: var(--accent-text);
	}
	.clarified {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--accent-text);
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
	}
	pre {
		margin: 0;
		padding: 12px 14px;
		overflow-x: auto;
		font-family: var(--mono);
		font-size: 12.5px;
		line-height: 1.65;
	}
	:global(.well) pre {
		font-size: 12px;
	}
	:global(.well .well) pre {
		font-size: 11.5px;
	}
	code {
		font-family: inherit;
	}
</style>
