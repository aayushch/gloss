<script lang="ts">
	// Fenced code with a language header and highlighted tokens. A code block
	// never shows an in-text mark; when a clarification is anchored to it the
	// header says so instead. The header's copy button puts the raw code on
	// the clipboard and shows "Copied" for a moment.
	import { highlightLines, plainLines, supportsLang, type Token } from '$lib/markdown/highlight';
	import { copyText } from '$lib/clipboard';
	import Icon from './Icon.svelte';

	let {
		code,
		lang,
		clarified = false,
		nested = false
	}: { code: string; lang: string; clarified?: boolean; nested?: boolean } = $props();

	let lines = $state<Token[][]>([]);
	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy(): Promise<void> {
		const ok = await copyText(code);
		if (!ok) return;
		copied = true;
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied = false), 1500);
	}

	$effect(() => {
		const c = code;
		const l = lang;
		lines = plainLines(c);
		if (!supportsLang(l)) return;
		let alive = true;
		highlightLines(c, l).then((res) => {
			if (alive) lines = res;
		});
		return () => {
			alive = false;
		};
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
