// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Tells a selection the reader is editing apart from one in page text, so
// the "Ask about this" pill stays out of the way while they type.

/**
 * True when `node` sits in text the reader can edit: a form control, or a
 * rich-text editor's content. A contenteditable region alone does not
 * count: diff and code viewers (Bitbucket's diff view among them) render
 * read-only text inside contenteditable elements to control how the
 * browser selects it. An editor is recognised by the `role="textbox"`
 * that editing libraries put on their content element (Gmail, Draft.js,
 * Lexical, Quill, the Atlassian editor, CodeMirror 6), unless that text
 * box says it is read-only.
 */
export function isEditing(node: Node): boolean {
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	if (!el) return false;
	if (el.closest('input, textarea, select')) return true;
	const box = el.closest('[role="textbox"]');
	if (!box) return false;
	return box.getAttribute('aria-readonly') !== 'true' && !box.hasAttribute('readonly');
}
