// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// A client of the background: opens the runtime port, sends requests and
// receives pushed events. Used by the content script, the popup and the
// ask window. The port reconnects when the background goes away (Chrome
// stops idle service workers), replaying the last subscription.
//
// Safari needs one more step. It unloads the background page about 30 s
// after its last event, even while ports to it are open, and it does not
// fire `onDisconnect` on those ports. A request posted on such a port is
// dropped, and posting does not load the background again. So on Safari
// every request first sends a `BackgroundPing` with `runtime.sendMessage`,
// which does load the background. If the reply's `instance` differs from
// the one in the port's `welcome` message, the port is replaced before the
// request is sent.

import { browser } from './browser';
import {
	LOCAL_METHODS,
	PORT_NAME,
	type BackgroundMessage,
	type BackgroundPing,
	type BackgroundPingReply,
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

/**
 * How long a request may wait for its response before it fails. The
 * background answers within about 60 s even in its slowest case (a `hello`
 * to Gloss and then the request, each limited to 30 s on Safari and 60 s
 * through the native port). This limit only matters when a request or its
 * response is lost, so the UI shows an error instead of waiting forever.
 */
const REQUEST_TIMEOUT_MS = 90_000;
/**
 * How long the Safari ping may take. A background that is loaded answers in
 * milliseconds, and one that Safari has to load first answers well within
 * this. A ping still unanswered after this means the background cannot be
 * reached, and the request fails.
 */
const PING_TIMEOUT_MS = 5_000;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: BridgeFailure) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface ClientOptions {
	/**
	 * Whether each request first sends a `BackgroundPing` and replaces a
	 * port whose background has been unloaded. On by default in the Safari
	 * build, the only browser that unloads the background without ending
	 * its ports.
	 */
	pingBackground?: boolean;
}

export function connectClient(options: ClientOptions = {}): Client {
	const pingBackground = options.pingBackground ?? __BROWSER__ === 'safari';
	let port: chrome.runtime.Port | null = null;
	let closed = false;
	let suspended = false;
	let nextId = 1;
	let reconnectDelay = 500;
	const pending = new Map<string, Pending>();
	const eventHandlers = new Set<EventHandler>();
	let subscription: ClientMessage | null = null;
	/**
	 * The `instance` of the background script the current port is attached
	 * to. It is null from the moment a port is opened until its `welcome`
	 * message or a ping reply arrives.
	 */
	let portInstance: string | null = null;

	function onMessage(msg: BackgroundMessage) {
		if (msg.type === 'welcome') {
			portInstance = msg.instance;
		} else if (msg.type === 'response') {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new BridgeFailure(msg.error.code, msg.error.message));
			else p.resolve(msg.result);
		} else if (msg.type === 'event') {
			for (const h of eventHandlers) h(msg.event, msg.data);
		}
	}

	/** Fails every request still waiting for a response. */
	function failPending(message: string) {
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(new BridgeFailure('internal', message));
		}
		pending.clear();
	}

	/**
	 * Handles the end of `which`. A port this client dropped itself, because
	 * it was attached to an unloaded background, is ignored here, so its
	 * late disconnect cannot clear the port that replaced it.
	 */
	function onDisconnect(which: chrome.runtime.Port) {
		if (which !== port) return;
		port = null;
		portInstance = null;
		failPending('the background went away');
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
		portInstance = null;
		const opened = port;
		port.onMessage.addListener(onMessage as (msg: unknown) => void);
		port.onDisconnect.addListener(() => onDisconnect(opened));
		if (subscription) port.postMessage(subscription);
	}

	/**
	 * Runs only when `pingBackground` is on. Loads the background if Safari
	 * unloaded it, and replaces the port when it is attached to a background
	 * script that is no longer running. Requests still waiting on the old
	 * port fail, since their responses will never arrive.
	 *
	 * Throws when the ping fails, gets no answer, or takes longer than
	 * `PING_TIMEOUT_MS`. That happens in a tab that was open while Safari
	 * replaced or restarted the extension: the tab keeps running the old
	 * copy of this script, which can no longer reach the background over
	 * any channel. Only reloading the page fixes it, so the error says so.
	 */
	async function ensureLiveBackground(): Promise<void> {
		if (!pingBackground || closed || suspended) return;
		let reply: BackgroundPingReply | undefined;
		try {
			reply = (await Promise.race([
				browser.runtime.sendMessage({ type: 'background-ping' } satisfies BackgroundPing),
				new Promise((r) => setTimeout(() => r(undefined), PING_TIMEOUT_MS))
			])) as BackgroundPingReply | undefined;
		} catch {
			reply = undefined;
		}
		const instance = reply?.instance;
		if (!instance) throw unreachableBackground();
		// The port is kept when it belongs to the background that answered.
		// That is the case when its welcome carried the same instance. It is
		// also the case when its welcome has not arrived yet: the port was
		// opened moments ago, so it attached to the background running now.
		if (port && (portInstance === null || portInstance === instance)) {
			portInstance = instance;
			return;
		}
		if (port) {
			const stale = port;
			port = null;
			try {
				stale.disconnect();
			} catch {
				// The port is already unusable; dropping it is enough.
			}
			failPending('the background restarted');
		}
		connect();
		if (port) portInstance = instance;
	}

	connect();

	return {
		async request<T>(method: string, params?: unknown): Promise<T> {
			await ensureLiveBackground();
			return new Promise<T>((resolve, reject) => {
				if (!port) connect();
				if (!port) {
					reject(new BridgeFailure('internal', 'cannot reach the extension background'));
					return;
				}
				const id = String(nextId++);
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new BridgeFailure('internal', 'the Gloss extension did not answer; try again'));
				}, REQUEST_TIMEOUT_MS);
				pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
				try {
					port.postMessage({ type: 'request', id, method, params } satisfies ClientMessage);
				} catch (e) {
					clearTimeout(timer);
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
			portInstance = null;
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
			portInstance = null;
		}
	};
}

/** The error a request gets when this copy of the extension cannot reach its background. */
function unreachableBackground(): BridgeFailure {
	return new BridgeFailure(
		'internal',
		'This page cannot reach the Gloss extension. It may have been updated or turned off and on since the page loaded. Reload the page and ask again.'
	);
}
