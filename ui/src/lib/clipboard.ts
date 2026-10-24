// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Copies text to the system clipboard. The async clipboard API is used when
// the webview exposes it; otherwise a hidden textarea and the legacy copy
// command do the work, which covers older WebKitGTK builds on Linux.

export async function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Falls through to the textarea path below.
		}
	}
	if (typeof document === 'undefined') return false;
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	ta.remove();
	return ok;
}
