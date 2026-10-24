// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { mergeLines, plainLines, type Token } from './highlight';

describe('mergeLines', () => {
	const kw = (t: string): Token => ({ t, cls: 'syn-kw' });

	it('keeps highlighted lines whose text is unchanged and shows new ones plain', () => {
		const prev: Token[][] = [
			[kw('int'), { t: ' a;' }],
			[kw('int'), { t: ' b' }]
		];
		const out = mergeLines(prev, 'int a;\nint b;\nint c;');
		expect(out[0]).toBe(prev[0]);
		expect(out[1]).toEqual([{ t: 'int b;' }]);
		expect(out[2]).toEqual([{ t: 'int c;' }]);
	});

	it('drops lines the code no longer has', () => {
		expect(mergeLines(plainLines('a\nb\nc'), 'a')).toEqual([[{ t: 'a' }]]);
	});

	it('starts plain when nothing was highlighted yet', () => {
		expect(mergeLines([], 'x\n')).toEqual([[{ t: 'x' }], [{ t: '' }]]);
	});
});
