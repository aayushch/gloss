// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// A client of the background: opens the runtime port, sends requests and
// receives pushed events. Used by the content script, the popup and the
// ask window. The port reconnects when the background goes away (Chrome
// stops idle service workers), replaying the last subscription.

import { browser } from './browser';
import {
	LOCAL_METHODS,
	PORT_NAME,
	type BackgroundMessage,
	type ClientMessage,
	type ConnectionStatus
} from './messages';
import { BridgeFailure, DEFAULT_SETTINGS } from './protocol';

export type EventHandler = (event: string, data: unknown) => void;

export interface Client {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	/** Pushed events (`turn`, `page`, `settings`, `app_state`, `shutdown`, `connection`). */
	onEvent(handler: EventHandler): () => void;
	subscribe(keys: {
		urlKey: string | null;
		conversationId: string | null;
		askCount?: number;
	}): void;
	status(): Promise<ConnectionStatus>;
	/** Drops the port without reconnecting, until `resume`. */
	suspend(): void;
	/** Connects again after `suspend`, replaying the subscription. */
	resume(): void;
	close(): void;
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: BridgeFailure) => void;
}

export function connectClient(): Client {
	let port: chrome.runtime.Port | null = null;
	let closed = false;
	let suspended = false;
	let nextId = 1;
	let reconnectDelay = 500;
	const pending = new Map<string, Pending>();
	const eventHandlers = new Set<EventHandler>();
	let subscription: ClientMessage | null = null;

	function onMessage(msg: BackgroundMessage) {
		if (msg.type === 'response') {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.error) p.reject(new BridgeFailure(msg.error.code, msg.error.message));
			else p.resolve(msg.result);
		} else if (msg.type === 'event') {
			for (const h of eventHandlers) h(msg.event, msg.data);
		}
	}

	function onDisconnect() {
		port = null;
		for (const p of pending.values())
			p.reject(new BridgeFailure('internal', 'the background went away'));
		pending.clear();
		if (closed || suspended) return;
		setTimeout(connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
	}

	function connect() {
		if (closed || suspended || port) return;
		try {
			port = browser.runtime.connect({ name: PORT_NAME });
		} catch {
			port = null;
			setTimeout(connect, reconnectDelay);
			reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
			return;
		}
		reconnectDelay = 500;
		port.onMessage.addListener(onMessage as (msg: unknown) => void);
		port.onDisconnect.addListener(onDisconnect);
		if (subscription) port.postMessage(subscription);
	}

	connect();

	return {
		request<T>(method: string, params?: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				if (!port) connect();
				if (!port) {
					reject(new BridgeFailure('internal', 'cannot reach the extension background'));
					return;
				}
				const id = String(nextId++);
				pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
				try {
					port.postMessage({ type: 'request', id, method, params } satisfies ClientMessage);
				} catch (e) {
					pending.delete(id);
					reject(new BridgeFailure('internal', e instanceof Error ? e.message : String(e)));
				}
			});
		},
		onEvent(handler) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		subscribe(keys) {
			subscription = { type: 'subscribe', ...keys };
			if (port) port.postMessage(subscription);
		},
		async status() {
			try {
				return await this.request<ConnectionStatus>(LOCAL_METHODS.status);
			} catch (e) {
				return {
					state: 'error',
					message: e instanceof Error ? e.message : String(e),
					settings: DEFAULT_SETTINGS
				};
			}
		},
		suspend() {
			suspended = true;
			port?.disconnect();
			port = null;
		},
		resume() {
			suspended = false;
			reconnectDelay = 500;
			connect();
		},
		close() {
			closed = true;
			port?.disconnect();
			port = null;
		}
	};
}
