// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { parseBlocks } from './blocks';

describe('parseBlocks', () => {
	it('parses paragraphs and headings with ids', () => {
		const b = parseBlocks('# Title\n\nSome **bold** and `code` text.', 't1');
		expect(b).toHaveLength(2);
		expect(b[0]).toMatchObject({ id: 't1:0', kind: 'h', level: 1, text: 'Title' });
		expect(b[1].id).toBe('t1:1');
		expect(b[1].text).toBe('Some bold and code text.');
		expect(b[1].runs).toEqual([
			{ t: 'Some ' },
			{ t: 'bold', b: true },
			{ t: ' and ' },
			{ t: 'code', code: true },
			{ t: ' text.' }
		]);
	});

	it('flattens nested lists into li blocks with depth and numbers', () => {
		const b = parseBlocks('- a\n  - b\n  - c\n- d\n\n1. x\n2. y', 't');
		const li = b.filter((x) => x.kind === 'li');
		expect(li.map((x) => [x.text, x.depth, x.ordered, x.num])).toEqual([
			['a', 0, false, undefined],
			['b', 1, false, undefined],
			['c', 1, false, undefined],
			['d', 0, false, undefined],
			['x', 0, true, 1],
			['y', 0, true, 2]
		]);
	});

	it('keeps code fences, including an unterminated trailing one', () => {
		const b = parseBlocks('text\n\n```rust\nfn main() {}\n```\n\n```py\nprint(1)', 't');
		expect(b[1]).toMatchObject({ kind: 'code', lang: 'rust', code: 'fn main() {}' });
		expect(b[2]).toMatchObject({ kind: 'code', lang: 'py', code: 'print(1)' });
	});

	it('parses tables into rows of runs', () => {
		const b = parseBlocks('| a | b |\n|---|---|\n| 1 | **2** |', 't');
		expect(b[0].kind).toBe('table');
		expect(b[0].rows).toHaveLength(2);
		expect(b[0].rows?.[1][1]).toEqual([{ t: '2', b: true }]);
	});

	it('handles quotes, rules, links and italics', () => {
		const b = parseBlocks('> quoted *text*\n\n---\n\nSee [docs](https://x.y).', 't');
		expect(b[0]).toMatchObject({ kind: 'quote', text: 'quoted text' });
		expect(b[0].runs[1]).toEqual({ t: 'text', i: true });
		expect(b[1].kind).toBe('hr');
		expect(b[2].runs[1]).toEqual({ t: 'docs', href: 'https://x.y' });
	});

	it('emits nested paragraphs and code under a list item as separate blocks', () => {
		const b = parseBlocks('- item\n\n  more text\n\n  ```js\n  x\n  ```\n- next', 't');
		expect(b.map((x) => x.kind)).toEqual(['li', 'p', 'code', 'li']);
		expect(b[1].depth).toBe(1);
	});

	it('returns no blocks for empty input', () => {
		expect(parseBlocks('', 't')).toEqual([]);
	});
});
