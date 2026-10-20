import { describe, expect, it } from 'vitest';
import { GUARD_KEY, type GuardHolder } from '../src/content/events';

describe('guard.ts', () => {
	it('runs the guard before window capture listeners the page adds later', async () => {
		// guard.ts runs at document_start, before any page script.
		await import('../src/content/guard');
		const seen: string[] = [];
		window.addEventListener('keydown', () => seen.push('page'), true);
		const holder = globalThis as GuardHolder;

		holder[GUARD_KEY] = (e) => e.stopImmediatePropagation();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
		expect(seen).toEqual([]);

		// Before the main content script installs its guard, the page sees every key.
		delete holder[GUARD_KEY];
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
		expect(seen).toEqual(['page']);
	});
});
