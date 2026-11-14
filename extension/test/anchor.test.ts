// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	describe as describeRange,
	resolve,
	resolveOnOtherView,
	cssPath
} from '../src/content/anchor';
import { TextIndex } from '../src/content/text';
import type { WebAnchor } from '../src/shared/protocol';

const ARTICLE = `
<main><article>
<h1>Store buffers</h1>
<p>Modern CPUs keep a small queue of pending writes called the store buffer.</p>
<p>The store buffer lets the core continue past a write that would otherwise stall on the cache.</p>
<p>Because loads may bypass earlier stores, the order other cores observe can differ from program order.</p>
<p>A memory barrier drains the store buffer before later instructions proceed.</p>
</article></main>`;

function load(html: string): TextIndex {
	document.body.innerHTML = html;
	return TextIndex.ofDocument(document);
}

/** Selects `needle` inside the page's text and describes it. */
function anchorFor(idx: TextIndex, needle: string): WebAnchor {
	const start = idx.text.indexOf(needle);
	expect(start).toBeGreaterThanOrEqual(0);
	const range = idx.toRange(start, start + needle.length);
	const anchor = describeRange(range, idx)!;
	expect(anchor.quote.exact).toBe(needle);
	return anchor;
}

describe('describe', () => {
	it('records quote, context, position and container', () => {
		const idx = load(ARTICLE);
		const a = anchorFor(idx, 'continue past a write');
		expect(a.position).toEqual({
			start: idx.text.indexOf('continue past'),
			end: idx.text.indexOf('continue past') + 'continue past a write'.length
		});
		expect(a.quote.prefix.endsWith('lets the core ')).toBe(true);
		expect(a.quote.suffix.startsWith(' that would')).toBe(true);
		expect(a.container).toBe('main > article > p:nth-of-type(2)');
	});

	it('trims selection whitespace off the quote', () => {
		const idx = load('<p>alpha beta gamma</p>');
		const range = idx.toRange(5, 11);
		expect(range.toString()).toBe(' beta ');
		const a = describeRange(range, idx)!;
		expect(a.quote.exact).toBe('beta');
		expect(a.position).toEqual({ start: 6, end: 10 });
	});

	it('cssPath stops at an id', () => {
		load('<div id="root"><section><p>a</p><p>b</p></section></div>');
		expect(cssPath(document.querySelectorAll('p')[1])).toBe('#root > section > p:nth-of-type(2)');
	});
});

describe('resolve', () => {
	it('anchors by position on an unchanged page', () => {
		const idx = load(ARTICLE);
		const a = anchorFor(idx, 'drains the store buffer');
		const r = resolve(a, idx)!;
		expect(r.state).toBe('anchored');
		expect(r.range.toString()).toBe('drains the store buffer');
		expect(r.offsets).toEqual(a.position);
	});

	it('picks the right copy of a duplicated sentence by its context', () => {
		const idx = load(
			'<p>Intro.</p><p>Same line here. After one.</p><p>Same line here. After two.</p>'
		);
		const second = idx.text.lastIndexOf('Same line here.');
		const a = describeRange(idx.toRange(second, second + 'Same line here.'.length), idx)!;
		expect(a.quote.suffix.startsWith(' After two.')).toBe(true);
		// A new paragraph at the top shifts every position.
		const changed = load(
			'<p>A brand new introduction paragraph.</p><p>Intro.</p><p>Same line here. After one.</p><p>Same line here. After two.</p>'
		);
		const r = resolve(a, changed)!;
		expect(r.state).toBe('anchored');
		expect(changed.text.slice(r.offsets.start, r.offsets.end + ' After two.'.length)).toBe(
			'Same line here. After two.'
		);
	});

	it('anchors a paragraph that moved', () => {
		const idx = load(ARTICLE);
		const a = anchorFor(idx, 'loads may bypass earlier stores');
		const moved = load(`
<main><article>
<h1>Store buffers</h1>
<p>Because loads may bypass earlier stores, the order other cores observe can differ from program order.</p>
<p>Modern CPUs keep a small queue of pending writes called the store buffer.</p>
<p>The store buffer lets the core continue past a write that would otherwise stall on the cache.</p>
<p>A memory barrier drains the store buffer before later instructions proceed.</p>
</article></main>`);
		const r = resolve(a, moved)!;
		expect(r.state).toBe('anchored');
		expect(r.range.toString()).toBe('loads may bypass earlier stores');
	});

	it('finds an edited passage approximately', () => {
		const idx = load(ARTICLE);
		const a = anchorFor(idx, 'the order other cores observe can differ from program order');
		const edited = load(ARTICLE.replace('other cores observe', 'another core sees'));
		const r = resolve(a, edited)!;
		expect(r.state).toBe('fuzzy');
		expect(r.range.toString()).toContain('another core sees');
		expect(r.range.toString()).toContain('program order');
	});

	it('leaves out the approximate match when asked to', () => {
		const idx = load(ARTICLE);
		const a = anchorFor(idx, 'the order other cores observe can differ from program order');
		const edited = load(ARTICLE.replace('other cores observe', 'another core sees'));
		expect(resolve(a, edited, false)).toBeNull();
		expect(resolve(a, idx, false)?.state).toBe('anchored');
	});

	it('tolerates re-typeset quotes inside the same container', () => {
		const idx = load('<main><p>He said "store buffer" and left.</p></main>');
		const a = anchorFor(idx, 'said "store buffer" and');
		const curly = load('<main><p>He said “store buffer” and left.</p></main>');
		const r = resolve(a, curly)!;
		expect(r.state).toBe('anchored');
		expect(r.range.toString()).toBe('said “store buffer” and');
	});

	it('returns null when the passage is gone', () => {
		const idx = load(ARTICLE);
		const a = anchorFor(idx, 'A memory barrier drains the store buffer');
		const without = load(
			ARTICLE.replace(
				/<p>A memory barrier.*?<\/p>/,
				'<p>Fences are discussed elsewhere entirely.</p>'
			)
		);
		expect(resolve(a, without)).toBeNull();
	});

	it('handles a quote spanning two paragraphs', () => {
		const idx = load(ARTICLE);
		const a = anchorFor(idx, 'store buffer. The store buffer lets');
		expect(a.quote.exact).toBe('store buffer. The store buffer lets');
		const r = resolve(a, load(ARTICLE))!;
		expect(r.state).toBe('anchored');
		expect(r.range.toString().replace(/\s+/g, ' ')).toBe('store buffer. The store buffer lets');
		expect(r.range.startContainer).not.toBe(r.range.endContainer);
	});

	it('is whitespace-insensitive for quotes made elsewhere', () => {
		const idx = load('<p>alpha   beta\ngamma</p>');
		const a: WebAnchor = {
			quote: { exact: '  beta \n gamma ', prefix: '', suffix: '' },
			position: null,
			container: null
		};
		const r = resolve(a, idx)!;
		expect(r.state).toBe('anchored');
		expect(r.range.toString()).toBe('beta\ngamma');
	});
});

describe('resolveOnOtherView', () => {
	// Two files of one diff, as a page shows them under two URL fragments.
	const FOO = `
<table>
<tr><td>10</td><td>Order order = repository.load(id);</td></tr>
<tr><td>11</td><td>if (order == null) {</td></tr>
<tr><td>12</td><td>return null;</td></tr>
<tr><td>13</td><td>}</td></tr>
</table>`;
	const BAR = `
<table>
<tr><td>40</td><td>List orders = customers.find(name);</td></tr>
<tr><td>41</td><td>if (orders == null) {</td></tr>
<tr><td>42</td><td>return null;</td></tr>
<tr><td>43</td><td>}</td></tr>
</table>`;

	it('leaves a passage off a view where only its words occur', () => {
		const a = anchorFor(load(FOO), 'return null;');
		const bar = load(BAR);
		// The words are in the other file, so the search for an ask of this view finds them.
		expect(resolve(a, bar)!.state).toBe('anchored');
		expect(resolveOnOtherView(a, bar)).toBeNull();
	});

	it('leaves out a passage that only resembles text on the view', () => {
		const a = anchorFor(load(FOO), 'if (order == null) {');
		const bar = load(BAR);
		expect(resolve(a, bar)!.state).toBe('fuzzy');
		expect(resolveOnOtherView(a, bar)).toBeNull();
	});

	it('places a passage whose surroundings are the same on the view', () => {
		const foo = load(FOO);
		const a = anchorFor(foo, 'return null;');
		// The same file under another fragment, with a banner above it.
		const again = load('<p>Reviewed by two people.</p>' + FOO);
		const r = resolveOnOtherView(a, again)!;
		expect(r.state).toBe('anchored');
		expect(r.range.toString()).toBe('return null;');
		expect(r.offsets.start).toBe(again.text.indexOf('return null;'));
	});

	it('picks the copy nearest the recorded position among equal surroundings', () => {
		const twice = load(FOO + FOO);
		const second = twice.text.lastIndexOf('return null;');
		const a = describeRange(twice.toRange(second, second + 'return null;'.length), twice)!;
		expect(resolveOnOtherView(a, twice)!.offsets.start).toBe(second);
	});

	it('never places an anchor that recorded no surroundings', () => {
		const idx = load('<p>return null;</p>');
		const a = anchorFor(idx, 'return null;');
		expect(a.quote.prefix + a.quote.suffix).toBe('');
		expect(resolveOnOtherView(a, idx)).toBeNull();
	});
});
