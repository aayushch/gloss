// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { isEditing } from '../src/content/editable';

function first(html: string, selector: string): Node {
	document.body.innerHTML = html;
	const el = document.querySelector(selector);
	if (!el) throw new Error('no ' + selector);
	return el.firstChild ?? el;
}

describe('isEditing', () => {
	it('is false for page text', () => {
		expect(isEditing(first('<p>plain <em>text</em></p>', 'em'))).toBe(false);
	});

	it('is true inside form controls', () => {
		expect(isEditing(first('<textarea>draft</textarea>', 'textarea'))).toBe(true);
		expect(isEditing(first('<input value="x">', 'input'))).toBe(true);
	});

	it('is true in a rich-text editor that presents a writable text box', () => {
		const html = '<div contenteditable="true" role="textbox"><p>my <b>draft</b></p></div>';
		expect(isEditing(first(html, 'b'))).toBe(true);
	});

	it('is false in a read-only text box', () => {
		const html =
			'<div contenteditable="true" role="textbox" aria-readonly="true"><span>code</span></div>';
		expect(isEditing(first(html, 'span'))).toBe(false);
	});

	it('is false for a contenteditable viewer that is not a text box', () => {
		// Bitbucket's diff view: read-only lines inside a contenteditable element.
		const html =
			'<div contenteditable="true"><div class="line"><span>// a comment</span></div></div>';
		expect(isEditing(first(html, 'span'))).toBe(false);
	});
});
