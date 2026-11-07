// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackgroundMessage, ClientMessage } from '../src/shared/messages';

/**
 * A stand-in for the extension background as Safari runs it. `unload()`
 * ends the current run of the background script the way Safari does after
 * 30 s idle: ports opened against it stay open, nothing fires
 * `onDisconnect`, and messages posted on them are dropped. A one-shot
 * `runtime.sendMessage` starts a new run with a new instance id.
 */
class FakeBackground {
	instance = 'run-1';
	loaded = true;
	runs = 1;
	/** Requests the background received, by method. */
	received: string[] = [];

	load(): void {
		if (this.loaded) return;
		this.runs += 1;
		this.instance = `run-${this.runs}`;
		this.loaded = true;
	}

	unload(): void {
		this.loaded = false;
	}

	connect(): chrome.runtime.Port {
		this.load();
		const attachedTo = this.instance;
		const messageListeners: ((m: BackgroundMessage) => void)[] = [];
		const deliver = (m: BackgroundMessage) =>
			queueMicrotask(() => messageListeners.forEach((l) => l(m)));
		const port = {
			name: 'gloss',
			onMessage: { addListener: (l: (m: BackgroundMessage) => void) => messageListeners.push(l) },
			onDisconnect: { addListener: () => {} },
			disconnect: () => {},
			postMessage: (m: ClientMessage) => {
				// A port whose background run has ended delivers nothing.
				if (!this.loaded || this.instance !== attachedTo) return;
				if (m.type !== 'request') return;
				this.received.push(m.method);
				deliver({ type: 'response', id: m.id, result: { ok: m.method } });
			}
		};
		deliver({ type: 'welcome', instance: attachedTo });
		return port as unknown as chrome.runtime.Port;
	}
}

const bg = new FakeBackground();
let connectClient: typeof import('../src/shared/client').connectClient;

beforeAll(async () => {
	vi.stubGlobal('chrome', {
		runtime: {
			connect: () => bg.connect(),
			sendMessage: async () => {
				bg.load();
				return { instance: bg.instance };
			}
		}
	});
	({ connectClient } = await import('../src/shared/client'));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('connectClient with pingBackground', () => {
	it('replaces a port whose background was unloaded, so the request is answered', async () => {
		const client = connectClient({ pingBackground: true });
		await expect(client.request('getPage')).resolves.toEqual({ ok: 'getPage' });

		bg.unload();
		await expect(client.request('ask')).resolves.toEqual({ ok: 'ask' });
		expect(bg.received).toEqual(['getPage', 'ask']);
		client.close();
	});
});

describe('connectClient with pingBackground, in a tab the extension was replaced under', () => {
	it('fails the request at once, asking for a reload, when the ping cannot reach the background', async () => {
		const client = connectClient({ pingBackground: true });
		const sendMessage = chrome.runtime.sendMessage;
		chrome.runtime.sendMessage = (async () => {
			throw new Error('Extension context invalidated.');
		}) as typeof chrome.runtime.sendMessage;
		try {
			await expect(client.request('ask')).rejects.toThrow(/Reload the page/);
		} finally {
			chrome.runtime.sendMessage = sendMessage;
			client.close();
		}
	});
});

describe('connectClient without pingBackground', () => {
	it('fails a request that is never answered instead of waiting forever', async () => {
		vi.useFakeTimers();
		const client = connectClient({ pingBackground: false });
		bg.unload();
		const pending = client.request('ask');
		const outcome = expect(pending).rejects.toThrow(/did not answer/);
		await vi.advanceTimersByTimeAsync(90_000);
		await outcome;
		client.close();
		bg.load();
	});
});
