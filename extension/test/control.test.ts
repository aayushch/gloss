// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { controlSelection } from '../src/content/control';
import { occurrences } from '../src/content/text';

describe('controlSelection', () => {
	it('is the selected part of a focused textarea', () => {
		document.body.innerHTML = '<textarea>one two three</textarea>';
		const ta = document.querySelector('textarea')!;
		ta.focus();
		ta.setSelectionRange(4, 7);
		expect(controlSelection(document.activeElement)).toBe('two');
	});

	it('is null for an empty selection or a non-control', () => {
		document.body.innerHTML = '<textarea>text</textarea><p>para</p>';
		const ta = document.querySelector('textarea')!;
		ta.setSelectionRange(2, 2);
		expect(controlSelection(ta)).toBeNull();
		expect(controlSelection(document.querySelector('p'))).toBeNull();
		expect(controlSelection(null)).toBeNull();
	});
});

describe('occurrences', () => {
	it('lists every start offset, within the given bounds', () => {
		expect(occurrences('ab ab ab', 'ab')).toEqual([0, 3, 6]);
		expect(occurrences('ab ab ab', 'ab', 1)).toEqual([3, 6]);
		expect(occurrences('ab ab ab', 'ab', 0, 7)).toEqual([0, 3]);
		expect(occurrences('ab', '')).toEqual([]);
	});
});
