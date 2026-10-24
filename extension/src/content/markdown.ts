// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Renders a reply's markdown to safe HTML for the popover.

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false, async: false });

let hooked = false;

/** Links in replies open in a new tab without a referrer or opener. */
function installHooks() {
	if (hooked) return;
	hooked = true;
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName === 'A') {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
	});
}

export function renderMarkdown(markdown: string): string {
	installHooks();
	const html = marked.parse(markdown ?? '', { async: false }) as string;
	return DOMPurify.sanitize(html, {
		FORBID_TAGS: [
			'iframe',
			'form',
			'script',
			'style',
			'object',
			'embed',
			'input',
			'button',
			'textarea',
			'select',
			'link',
			'meta'
		],
		FORBID_ATTR: ['onerror', 'onload', 'style'],
		ADD_ATTR: ['target']
	});
}
