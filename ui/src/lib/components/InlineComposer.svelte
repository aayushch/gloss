<script lang="ts">
	// Well-shaped composer that opens under the block holding a fresh highlight.
	import { short } from '$lib/state/threads';

	let {
		quote,
		nested = false,
		onsend,
		oncancel
	}: { quote: string; nested?: boolean; onsend: (text: string) => void; oncancel: () => void } = $props();

	let value = $state('');
	let ta: HTMLTextAreaElement | undefined = $state();

	$effect(() => {
		ta?.focus();
	});

	function grow(el: HTMLTextAreaElement) {
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 160) + 'px';
	}

	function send() {
		const t = value.trim();
		if (!t) return;
		onsend(t);
		value = '';
	}
</script>

<div class="composer well" class:nested>
	<div class="head">
		<span class="dot"></span>
		{nested ? 'Nested clarification' : 'Clarification'}
		<span class="re">re “{short(quote)}”</span>
	</div>
	<div class="body">
		<textarea
			bind:this={ta}
			bind:value
			class="iinput"
			rows="2"
			placeholder="Ask about the highlighted text…"
			oninput={(e) => grow(e.currentTarget)}
			onkeydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					send();
				} else if (e.key === 'Escape') {
					oncancel();
				}
			}}
		></textarea>
		<div class="actions">
			<button type="button" class="ibtn primary" onclick={send}>Ask</button>
			<button type="button" class="ibtn" onclick={oncancel}>Cancel</button>
		</div>
	</div>
</div>

<style>
	.composer {
		margin: 8px 0 20px 28px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 10px;
		font-size: 13px;
		overflow: hidden;
	}
	.composer.nested {
		background: var(--bg);
		margin-left: 16px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent-text);
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
	}
	.re {
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.body {
		padding: 0 12px 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	textarea {
		min-height: 52px;
		max-height: 160px;
		resize: none;
		font-size: 13px;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
</style>
