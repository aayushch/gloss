<script lang="ts">
	// What the agent is waiting on, shown under its pending reply: a tool
	// call to approve or refuse, or questions to answer. Submitting hands the
	// answer to the engine, which writes it to the agent's stdin.
	import type { AgentRequest, RequestAnswer } from '$lib/api/types';
	import Icon from './Icon.svelte';

	let { request, onanswer }: { request: AgentRequest; onanswer: (answer: RequestAnswer) => void } = $props();

	let reason = $state('');
	let busy = $state(false);
	/** Chosen option labels per question, in order; a typed answer counts as one label. */
	let chosen = $state<Record<string, string[]>>({});
	let typed = $state<Record<string, string>>({});

	function toggle(q: { question: string; multiSelect: boolean }, label: string) {
		const cur = chosen[q.question] ?? [];
		if (q.multiSelect) {
			chosen = { ...chosen, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
		} else {
			chosen = { ...chosen, [q.question]: [label] };
		}
	}

	const complete = $derived(
		request.kind === 'question' && request.questions.every((q) => (chosen[q.question]?.length ?? 0) > 0 || (typed[q.question] ?? '').trim())
	);

	function submit(answer: RequestAnswer) {
		if (busy) return;
		busy = true;
		onanswer(answer);
	}

	function submitQuestions() {
		if (request.kind !== 'question') return;
		const answers: Record<string, string> = {};
		for (const q of request.questions) {
			const t = (typed[q.question] ?? '').trim();
			answers[q.question] = t || (chosen[q.question] ?? []).join(', ');
		}
		submit({ kind: 'question', answers });
	}
</script>

<div class="card" role="group" aria-label={request.kind === 'permission' ? 'Permission request' : 'Questions from the agent'}>
	{#if request.kind === 'permission'}
		<div class="head"><Icon name="file" size={12} /> The agent wants to run <strong>{request.tool}</strong></div>
		<div class="title">{request.title}</div>
		{#if request.detail}<pre class="detail">{request.detail}</pre>{/if}
		<input class="iinput reason" placeholder="Reason, if you refuse (optional)" bind:value={reason} disabled={busy} />
		<div class="actions">
			<button type="button" class="ibtn primary" disabled={busy} onclick={() => submit({ kind: 'permission', allow: true, message: null, setMode: null })}>Allow</button>
			{#each request.suggestions as s (s.mode)}
				<button type="button" class="ibtn" disabled={busy} title="Allow this call and switch the conversation to {s.label} so calls like it stop asking" onclick={() => submit({ kind: 'permission', allow: true, message: null, setMode: s.mode })}>Allow and switch to {s.label}</button>
			{/each}
			<button type="button" class="ibtn" disabled={busy} onclick={() => submit({ kind: 'permission', allow: false, message: reason.trim() || null, setMode: null })}>Refuse</button>
		</div>
	{:else}
		<div class="head"><Icon name="file" size={12} /> The agent has a question</div>
		{#each request.questions as q (q.question)}
			<div class="question">
				{#if q.header}<span class="chip">{q.header}</span>{/if}
				<div class="qtext">{q.question}</div>
				<div class="options">
					{#each q.options as o (o.label)}
						<button type="button" class="opt" class:on={(chosen[q.question] ?? []).includes(o.label)} disabled={busy} onclick={() => toggle(q, o.label)}>
							<span class="olabel">{o.label}</span>
							{#if o.description}<span class="odesc">{o.description}</span>{/if}
						</button>
					{/each}
				</div>
				<input class="iinput other" placeholder="Or type an answer" bind:value={typed[q.question]} disabled={busy} />
			</div>
		{/each}
		<div class="actions">
			<button type="button" class="ibtn primary" disabled={busy || !complete} onclick={submitQuestions}>Send answer</button>
		</div>
	{/if}
</div>

<style>
	.card {
		margin: 10px 0 16px;
		padding: 12px 14px;
		border: 1px solid var(--accent);
		border-radius: 10px;
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent-text);
	}
	.head strong {
		text-transform: none;
		letter-spacing: 0;
	}
	.title {
		font-family: var(--mono);
		font-size: 12.5px;
		word-break: break-all;
	}
	.detail {
		margin: 0;
		max-height: 220px;
		overflow: auto;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--bg);
		font-family: var(--mono);
		font-size: 12px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.reason,
	.other {
		height: 28px;
		font-size: 12.5px;
		padding: 0 8px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.question {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.chip {
		align-self: flex-start;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-2);
		font-size: 11px;
	}
	.qtext {
		font-weight: 500;
	}
	.options {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.opt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		padding: 6px 10px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg);
		text-align: left;
	}
	.opt:hover {
		border-color: var(--accent);
	}
	.opt.on {
		border-color: var(--accent);
		background: var(--accent-tint);
	}
	.olabel {
		font-weight: 500;
	}
	.odesc {
		font-size: 12px;
		color: var(--text-2);
	}
</style>
