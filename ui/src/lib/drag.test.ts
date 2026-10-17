import { beforeEach, describe, expect, it, vi } from 'vitest';

const startDrag = vi.fn(async () => {});
let tauri = true;
vi.mock('$lib/api/client', () => ({
	inTauri: () => tauri,
	api: async () => ({ startDrag })
}));

import { titleMouseDown } from './drag';

function press(target: Element, init: MouseEventInit = {}) {
	const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
	target.dispatchEvent(e);
	return e;
}

describe('titleMouseDown', () => {
	let header: HTMLElement;
	beforeEach(() => {
		startDrag.mockClear();
		tauri = true;
		document.body.innerHTML = '<header><h1>Title</h1><button id="b">Pin</button></header>';
		header = document.querySelector('header')!;
		header.addEventListener('mousedown', titleMouseDown);
	});

	it('starts a drag for a single press on the title and swallows the default', async () => {
		const e = press(header.querySelector('h1')!);
		await Promise.resolve();
		expect(startDrag).toHaveBeenCalledWith(1);
		expect(e.defaultPrevented).toBe(true);
	});

	it('toggles maximize on a double click', async () => {
		press(header, { detail: 2 });
		await Promise.resolve();
		expect(startDrag).toHaveBeenCalledWith(2);
	});

	it('leaves controls, other buttons and triple clicks alone', async () => {
		press(header.querySelector('#b')!);
		press(header, { button: 2 });
		press(header, { detail: 3 });
		await Promise.resolve();
		expect(startDrag).not.toHaveBeenCalled();
	});

	it('does nothing in a plain browser', async () => {
		tauri = false;
		const e = press(header);
		await Promise.resolve();
		expect(startDrag).not.toHaveBeenCalled();
		expect(e.defaultPrevented).toBe(false);
	});
});
