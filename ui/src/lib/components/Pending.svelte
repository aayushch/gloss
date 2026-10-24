<!-- Copyright (c) 2026 Aayush Chawla -->
<!-- SPDX-License-Identifier: MIT -->

<!-- Three accent dots pulsing while a reply is awaited. -->
<div class="pending" aria-label="Waiting for reply">
	<span></span><span></span><span></span>
</div>

<style>
	.pending {
		display: inline-flex;
		gap: 5px;
		padding: 6px 0;
	}
	span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1s infinite;
	}
	span:nth-child(2) {
		animation-delay: 0.2s;
	}
	span:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 0.25;
		}
		50% {
			opacity: 1;
		}
	}
</style>
