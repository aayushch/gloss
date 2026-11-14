// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { TextIndex, lineRuns, normalise } from '../src/content/text';

function page(html: string): TextIndex {
	document.body.innerHTML = html;
	return TextIndex.ofDocument(document);
}

describe('TextIndex', () => {
	it('joins text across nested inline tags', () => {
		const idx = page('<p>The <em>quick <strong>brown</strong></em> fox</p>');
		expect(idx.text).toBe('The quick brown fox');
		const r = idx.toRange(4, 15);
		expect(r.toString()).toBe('quick brown');
	});

	it('treats <br> and block boundaries as one space', () => {
		const idx = page('<p>one<br>two</p><p>three</p><div>four</div>');
		expect(idx.text).toBe('one two three four');
	});

	it('skips hidden, aria-hidden, script and style nodes', () => {
		const idx = page(
			'<p>shown</p><p hidden>hidden</p><p aria-hidden="true">aria</p><script>var x;</script><style>p{}</style><p style="display:none">styled</p><gloss-ask-host>ui</gloss-ask-host><p>end</p>'
		);
		expect(idx.text).toBe('shown end');
	});

	it('collapses whitespace runs and keeps a map back to the DOM', () => {
		const idx = page('<p>  a \n\n  b\t\tc  </p>');
		expect(idx.text).toBe('a b c ');
		const r = idx.toRange(2, 5);
		expect(r.toString()).toBe('b\t\tc');
		expect(idx.fromRange(r)).toEqual({ start: 2, end: 5 });
	});

	it('maps a selection range to offsets and back', () => {
		const idx = page('<p id="a">Hello world</p><p id="b">Second para</p>');
		const a = document.getElementById('a')!.firstChild as Text;
		const b = document.getElementById('b')!.firstChild as Text;
		const r = document.createRange();
		r.setStart(a, 6);
		r.setEnd(b, 6);
		const offs = idx.fromRange(r)!;
		expect(idx.text.slice(offs.start, offs.end)).toBe('world Second');
		const back = idx.toRange(offs.start, offs.end);
		expect(back.startContainer).toBe(a);
		expect(back.startOffset).toBe(6);
		expect(back.endContainer).toBe(b);
		expect(back.endOffset).toBe(6);
	});

	it('accepts element boundary points', () => {
		const idx = page('<div><p>first</p><p>second</p><p>third</p></div>');
		const div = document.body.firstElementChild!;
		const r = document.createRange();
		r.setStart(div, 1);
		r.setEnd(div, 2);
		expect(idx.fromRange(r)).toEqual({ start: 6, end: 12 });
		expect(idx.text.slice(6, 12)).toBe('second');
	});

	it('returns null for ranges without indexed text', () => {
		const idx = page('<p>text</p><p hidden>secret</p>');
		const hidden = document.querySelectorAll('p')[1].firstChild as Text;
		const r = document.createRange();
		r.setStart(hidden, 0);
		r.setEnd(hidden, 3);
		expect(idx.fromRange(r)).toBeNull();
	});

	it('normalise collapses and trims', () => {
		expect(normalise('  a \n b  ')).toBe('a b');
	});
});

describe('lineRuns', () => {
	// A code editor's lines with its line numbers between them.
	const text = '3 Order order = load(id); 4 if (order == null) { 5 return null; 6 }';

	it('finds lines that have other text between them', () => {
		const lines = ['order = load(id);', 'if (order == null) {', 'return'];
		const start = text.indexOf('order = load');
		const end = text.indexOf('return') + 'return'.length;
		expect(lineRuns(text, lines, 10)).toEqual([{ start, end }]);
	});

	it('gives up when a line is further away than the gap allows', () => {
		expect(lineRuns(text, ['load(id);', 'return null;'], 10)).toEqual([]);
		expect(lineRuns(text, ['load(id);', 'return null;'], 40)).toHaveLength(1);
	});

	it('returns one run for each place the first line starts a full match', () => {
		const twice = `${text} ${text}`;
		const runs = lineRuns(twice, ['if (order == null) {', 'return null;'], 10);
		expect(runs.map((r) => twice.slice(r.start, r.end))).toEqual([
			'if (order == null) { 5 return null;',
			'if (order == null) { 5 return null;'
		]);
		// Limited to the first copy.
		expect(
			lineRuns(twice, ['if (order == null) {', 'return null;'], 10, 0, text.length)
		).toHaveLength(1);
	});

	it('finds nothing when the lines are out of order or missing', () => {
		expect(lineRuns(text, ['return null;', 'if (order == null) {'], 100)).toEqual([]);
		expect(lineRuns(text, ['if (order == null) {', 'throw'], 100)).toEqual([]);
		expect(lineRuns(text, [], 100)).toEqual([]);
	});
});
