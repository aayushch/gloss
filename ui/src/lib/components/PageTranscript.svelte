<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// The conversation of a web page asked about from the browser extension:
	// a card naming the page, the questions asked about the page as a whole,
	// then one card per highlighted passage with its thread under it. It
	// renders inside Transcript, which owns selection, jumps and scrolling.
	import type { Conversation, Turn } from '$lib/api/types';
	import { app } from '$lib/state/app.svelte';
	import {
		hostOf,
		pageQuestions,
		pageThreads,
		relativeTime,
		type Thread
	} from '$lib/state/threads';
	import AssistantTurn from './AssistantTurn.svelte';
	import Icon from './Icon.svelte';
	import PageAskCard from './PageAskCard.svelte';
	import UserBubble from './UserBubble.svelte';

	let { conv, threads }: { conv: Conversation; threads: Map<string, Thread> } = $props();

	const page = $derived(app.activePage);
	const url = $derived(page?.url ?? conv.pageKey ?? '');
	const title = $derived(page?.title || conv.title);
	const host = $derived(hostOf(url));
	const questions = $derived(pageQuestions(conv));
	const asks = $derived(pageThreads(conv));

	/** The user turn that produced an assistant turn, for the retry button. */
	function userBefore(turns: Turn[], i: number): Turn | undefined {
		for (let j = i - 1; j >= 0; j--) if (turns[j].role === 'user') return turns[j];
		return undefined;
	}
</script>

<div class="page">
	<div class="favicon">
		{#if page?.faviconUrl}
			<img src={page.faviconUrl} alt="" width="20" height="20" />
		{:else}
			<span class="letter">{host.charAt(0).toUpperCase()}</span>
		{/if}
	</div>
	<div class="text">
		<div class="title">{title}</div>
		<button
			type="button"
			class="url"
			title="Open {url} in the browser"
			onclick={() => app.openUrl(url)}>{url}</button
		>
		{#if page}
			<div class="seen">
				Last seen {relativeTime(page.lastSeen)}{page.orphanCount
					? ` · ${page.orphanCount} ${page.orphanCount === 1 ? 'ask is' : 'asks are'} not on the page any more`
					: ''}
			</div>
		{/if}
	</div>
	<button type="button" class="ibtn open" onclick={() => app.openUrl(url)}
		><Icon name="external" size={12} /> Open in browser</button
	>
</div>

{#each questions as t, i (t.id)}
	{#if t.role === 'user'}
		<UserBubble turn={t} />
	{:else}
		<AssistantTurn turn={t} userTurn={userBefore(questions, i)} {conv} {threads} />
	{/if}
{/each}

{#if asks.length}
	<div class="label">{asks.length} {asks.length === 1 ? 'passage' : 'passages'} asked about</div>
	{#each asks as th (th.clarification.id)}
		<PageAskCard thread={th} {conv} {threads} />
	{/each}
{:else if !questions.length}
	<div class="empty">
		Highlight text on the page in your browser and ask about it, or ask about the whole page below.
	</div>
{/if}

<style>
	.page {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 14px;
		margin: 0 0 22px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 12px;
	}
	.favicon {
		width: 28px;
		height: 28px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 7px;
		background: var(--bg);
		border: 1px solid var(--line);
		overflow: hidden;
	}
	.favicon img {
		display: block;
	}
	.letter {
		font-size: 13px;
		font-weight: 600;
		color: var(--accent-text);
	}
	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.url {
		font-size: 12px;
		color: var(--accent-text);
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.url:hover {
		text-decoration: underline;
	}
	.seen {
		font-size: 11.5px;
		color: var(--text-3);
	}
	.open {
		flex: none;
		font-size: 12px;
		padding: 5px 10px;
	}
	.label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-3);
		margin: 8px 0 12px;
	}
	.empty {
		color: var(--text-3);
		font-size: 13.5px;
		padding: 32px 0;
		text-align: center;
		max-width: 420px;
		margin: 0 auto;
	}
</style>
