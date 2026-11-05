// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// The selection of a code editor that draws its own selection. CodeMirror 5
// (Bitbucket's diff view), Ace and Monaco render the selected text as
// ordinary page text, paint the selection themselves, and keep the selected
// text in a hidden textarea they focus, so that copying works. The page's
// DOM selection is then collapsed inside that textarea and says nothing;
// the textarea does.

/**
 * The text selected inside the focused form control, or null when the
 * focused element is not a text control or its selection is empty.
 */
export function controlSelection(active: Element | null): string | null {
	if (!(active instanceof HTMLTextAreaElement) && !(active instanceof HTMLInputElement))
		return null;
	const start = active.selectionStart ?? 0;
	const end = active.selectionEnd ?? 0;
	if (end <= start) return null;
	return active.value.slice(start, end);
}

/**
 * True when the reader cannot see `el`: it has no size, is transparent or
 * invisible, lies outside the viewport on the top or left, or is clipped
 * away entirely by an ancestor that hides its overflow. A text control
 * like that is an editor's, holding text the reader selected elsewhere.
 */
export function isHiddenControl(el: HTMLElement): boolean {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return true;
	if (r.right <= 0 || r.bottom <= 0) return true;
	const style = getComputedStyle(el);
	if (style.opacity === '0' || style.visibility === 'hidden') return true;
	for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
		const ps = getComputedStyle(p);
		if (ps.overflow === 'visible' && ps.overflowX === 'visible' && ps.overflowY === 'visible')
			continue;
		const pr = p.getBoundingClientRect();
		if (pr.width === 0 || pr.height === 0) return true;
		if (r.bottom <= pr.top || r.top >= pr.bottom || r.right <= pr.left || r.left >= pr.right)
			return true;
	}
	return false;
}
