<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	// One-line note under the pending dots: what the agent is doing besides writing.
	import type { Activity } from '$lib/state/app.svelte';
	let { activity }: { activity: Activity } = $props();
</script>

<div class="activity">
	<span class="dot" class:tool={activity.kind === 'tool'}></span>
	<span class="label">{activity.label}</span>
</div>

<style>
	.activity {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--text-3);
		margin-top: 2px;
	}
	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--text-3);
	}
	.dot.tool {
		background: var(--accent);
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
