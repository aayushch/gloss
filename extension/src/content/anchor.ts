// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Describes a selected passage as a WebAnchor and finds that passage again
// on a later visit, even when the page has changed around it.

import search from 'approx-string-match';
import type { WebAnchor } from '../shared/protocol';
import { normalise, type Offsets, type TextIndex } from './text';

/** Characters of context kept on either side of the quote. */
const CONTEXT_CHARS = 32;

export interface Resolved {
	range: Range;
	offsets: Offsets;
	state: 'anchored' | 'fuzzy';
}

/** The nearest block-level ancestor element of a node, as a short CSS path. */
export function containerPath(node: Node): string | null {
	let el: Element | null =
		node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	const doc = node.ownerDocument;
	const win = doc?.defaultView;
	while (el && el !== doc?.body) {
		const display = win ? win.getComputedStyle(el).display : '';
		if (display && display !== 'inline' && !display.startsWith('inline-')) break;
		if (!display && !INLINE_TAGS.has(el.localName)) break;
		el = el.parentElement;
	}
	if (!el || el === doc?.body) return null;
	return cssPath(el);
}

const INLINE_TAGS = new Set([
	'a',
	'abbr',
	'b',
	'bdi',
	'bdo',
	'cite',
	'code',
	'data',
	'dfn',
	'em',
	'i',
	'kbd',
	'mark',
	'q',
	's',
	'samp',
	'small',
	'span',
	'strong',
	'sub',
	'sup',
	'time',
	'u',
	'var',
	'wbr',
	'label',
	'font',
	'del',
	'ins'
]);

/** A selector like `main > article > p:nth-of-type(3)`, cut short at the first element with an id. */
export function cssPath(el: Element): string {
	const parts: string[] = [];
	let cur: Element | null = el;
	while (cur && cur.localName !== 'body' && cur.localName !== 'html') {
		const id = cur.getAttribute('id');
		if (id && /^[A-Za-z_][\w-]*$/.test(id)) {
			parts.unshift(`#${id}`);
			break;
		}
		let part = cur.localName;
		const parent: Element | null = cur.parentElement;
		if (parent) {
			const siblings = Array.from(parent.children).filter((c) => c.localName === cur!.localName);
			if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
		}
		parts.unshift(part);
		cur = parent;
	}
	return parts.join(' > ');
}

/** Builds the anchor for a range, or null when the range holds no page text. */
export function describe(range: Range, index: TextIndex): WebAnchor | null {
	const offs = index.fromRange(range);
	if (!offs) return null;
	const text = index.text;
	let { start, end } = offs;
	while (start < end && text[start] === ' ') start++;
	while (end > start && text[end - 1] === ' ') end--;
	if (start >= end) return null;
	return {
		quote: {
			exact: text.slice(start, end),
			prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
			suffix: text.slice(end, end + CONTEXT_CHARS)
		},
		position: { start, end },
		container: containerPath(range.startContainer)
	};
}

/** Number of characters the end of `a` shares with the end of `b`. */
function commonSuffix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

/** Number of characters the start of `a` shares with the start of `b`. */
function commonPrefix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

function allOccurrences(text: string, needle: string): number[] {
	const out: number[] = [];
	let i = text.indexOf(needle);
	while (i >= 0) {
		out.push(i);
		i = text.indexOf(needle, i + 1);
	}
	return out;
}

/** Straightens curly quotes and dashes and lowercases, for the container-scoped stage. */
function fold(s: string): string {
	return s
		.replace(/[‘’‚′]/g, "'")
		.replace(/[“”„″]/g, '"')
		.replace(/[–—−]/g, '-')
		.replace(/…/g, '...')
		.toLowerCase();
}

/**
 * Finds the anchor's passage in the index.
 *
 * Stages, in order: the exact quote at its recorded position; the exact
 * quote anywhere, choosing by the context around it; the quote inside its
 * recorded container with quotes, dashes and case folded; an approximate
 * match allowing up to 20% edits (reported as `fuzzy`). `approximate`
 * false leaves out the last stage, the costliest, for the searches run
 * each time the page changes. Null means the passage is not on the page.
 */
export function resolve(anchor: WebAnchor, index: TextIndex, approximate = true): Resolved | null {
	const text = index.text;
	const exact = normalise(anchor.quote.exact);
	if (!exact) return null;
	// Context keeps its edge spaces: they are part of what surrounds the quote.
	const prefix = (anchor.quote.prefix ?? '').replace(/\s+/g, ' ');
	const suffix = (anchor.quote.suffix ?? '').replace(/\s+/g, ' ');
	const pos = anchor.position;
	const found = (start: number, end: number, state: 'anchored' | 'fuzzy'): Resolved => ({
		range: index.toRange(start, end),
		offsets: { start, end },
		state
	});

	// 1. Unchanged page: the quote still sits where it was.
	if (pos && text.startsWith(exact, pos.start)) {
		return found(pos.start, pos.start + exact.length, 'anchored');
	}

	// 2. The quote moved: pick the occurrence whose surroundings match best.
	const occurrences = allOccurrences(text, exact);
	if (occurrences.length) {
		let best = occurrences[0];
		let bestScore = -1;
		let bestDist = Infinity;
		for (const at of occurrences) {
			const before = text.slice(Math.max(0, at - CONTEXT_CHARS), at);
			const after = text.slice(at + exact.length, at + exact.length + CONTEXT_CHARS);
			const score = commonSuffix(prefix, before) + commonPrefix(suffix, after);
			const dist = pos ? Math.abs(at - pos.start) : 0;
			if (score > bestScore || (score === bestScore && dist < bestDist)) {
				best = at;
				bestScore = score;
				bestDist = dist;
			}
		}
		return found(best, best + exact.length, 'anchored');
	}

	// 3. Inside the recorded container, tolerate re-typeset punctuation and case.
	const scope = containerOffsets(anchor.container, index);
	if (scope) {
		const folded = fold(text.slice(scope.start, scope.end));
		const needle = fold(exact);
		if (folded.length === scope.end - scope.start && needle.length === exact.length) {
			const at = folded.indexOf(needle);
			if (at >= 0) return found(scope.start + at, scope.start + at + exact.length, 'anchored');
		}
	}

	// 4. Approximate match over the whole text.
	if (!approximate) return null;
	const maxErrors = Math.ceil(exact.length * 0.2);
	let matches = search(text, exact, maxErrors).filter((m) => m.end > m.start);
	if (matches.length) {
		// Among the lowest-error matches, prefer the one nearest the old position.
		const least = Math.min(...matches.map((m) => m.errors));
		matches = matches.filter((m) => m.errors === least);
		let best = matches[0];
		if (pos) {
			let bestDist = Infinity;
			for (const m of matches) {
				const d = Math.abs(m.start - pos.start);
				if (d < bestDist) {
					best = m;
					bestDist = d;
				}
			}
		}
		return found(best.start, best.end, 'fuzzy');
	}

	return null;
}

/** Offsets of the anchor's container element in the index, when the selector still finds one. */
function containerOffsets(selector: string | null | undefined, index: TextIndex): Offsets | null {
	if (!selector) return null;
	let el: Element | null = null;
	try {
		el = document.querySelector(selector);
	} catch {
		return null;
	}
	if (!el) return null;
	return index.ofElement(el);
}
