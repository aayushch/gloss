import { describe, expect, it } from 'vitest';
import { guardListening } from '../src/content/events';
import { HOST_TAG } from '../src/content/text';

describe('pageguard.ts', () => {
	it('keeps page listeners from events aimed inside the Gloss host, whenever they were added', async () => {
		// pageguard.ts runs in the page's world before any page script.
		await import('../src/content/pageguard');
		const host = document.createElement(HOST_TAG);
		const shadow = host.attachShadow({ mode: 'closed' });
		const box = document.createElement('textarea');
		shadow.appendChild(box);
		document.body.appendChild(host);
		const outside = document.createElement('input');
		document.body.appendChild(outside);

		const seen: string[] = [];
		const onKey = (e: Event) => seen.push(`${e.type}:${(e as KeyboardEvent).key}`);
		const handler = { handleEvent: (e: Event) => seen.push(`object:${e.type}`) };
		// jsdom's window does not inherit EventTarget.prototype as a browser's does, so the
		// test listens on the document and the body.
		document.body.addEventListener('keydown', onKey, true);
		document.addEventListener('keydown', handler);
		document.addEventListener('input', onKey);

		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true, composed: true }));
		expect(seen).toEqual([]);
		// Events the guard does not cover still reach the page.
		box.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
		expect(seen).toEqual(['input:undefined']);

		seen.length = 0;
		outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
		expect(seen).toEqual(['keydown:w', 'object:keydown']);

		// Removing a listener removes what was added for it.
		seen.length = 0;
		document.body.removeEventListener('keydown', onKey, true);
		document.removeEventListener('keydown', handler);
		outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
		expect(seen).toEqual([]);
	});

	it('tells whether guard.ts still listens on the window', async () => {
		expect(guardListening()).toBe(false);
		await import('../src/content/guard');
		expect(guardListening()).toBe(true);
	});
});
