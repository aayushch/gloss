// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { findRanges } from './find.svelte';

function root(html: string): HTMLElement {
	const el = document.createElement('div');
	el.innerHTML = html;
	document.body.appendChild(el);
	return el;
}

describe('findRanges', () => {
	it('finds every case-insensitive occurrence in document order', () => {
		const el = root('<p>The store buffer. the Store Buffer again.</p>');
		const r = findRanges(el, 'store buffer');
		expect(r.map((x) => x.toString())).toEqual(['store buffer', 'Store Buffer']);
	});

	it('matches across inline formatting', () => {
		const el = root('<p>drains the <strong>store</strong> buffer first</p>');
		const r = findRanges(el, 'store buffer');
		expect(r).toHaveLength(1);
		expect(r[0].toString()).toBe('store buffer');
	});

	it('skips button labels and opted-out elements', () => {
		const el = root(
			'<div><button>Copy</button><span data-nofind>copy</span><pre>copy this</pre></div>'
		);
		const r = findRanges(el, 'copy');
		expect(r).toHaveLength(1);
		expect(r[0].startContainer.parentElement?.tagName).toBe('PRE');
	});

	it('returns nothing for an empty query', () => {
		expect(findRanges(root('<p>x</p>'), '')).toEqual([]);
	});
});
