// Transport over a native messaging port to the `gloss-bridge` host.
// Each request is one port message; replies and pushed events arrive as
// port messages. The port is kept open (Chrome keeps the service worker
// alive while it is) and reopened with backoff when it drops.

import { browser } from '../shared/browser';
import { BridgeFailure, NATIVE_HOST, type BridgeIncoming } from '../shared/protocol';
import { Emitter, type Transport, type TransportState } from './transport';

const REQUEST_TIMEOUT_MS = 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: BridgeFailure) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class NativePortTransport implements Transport {
	readonly pushesEvents = true;
	state: TransportState = 'disconnected';
	private port: chrome.runtime.Port | null = null;
	private nextId = 1;
	private backoff = BACKOFF_MIN_MS;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly pending = new Map<string, Pending>();
	private readonly emitter = new Emitter();

	connect(): void {
		if (this.port) return;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.setState('connecting');
		let port: chrome.runtime.Port;
		try {
			port = browser.runtime.connectNative(NATIVE_HOST);
		} catch (e) {
			this.setState('disconnected', e instanceof Error ? e.message : String(e));
			this.scheduleReconnect();
			return;
		}
		this.port = port;
		port.onMessage.addListener((msg: BridgeIncoming) => this.onMessage(msg));
		port.onDisconnect.addListener(() => {
			const detail = browser.runtime.lastError?.message ?? (port as { error?: { message?: string } }).error?.message;
			this.onDisconnect(detail);
		});
		// The host is considered up until it disconnects: the port API gives
		// no earlier signal.
		this.backoff = BACKOFF_MIN_MS;
		this.setState('connected');
	}

	request(method: string, params?: unknown): Promise<unknown> {
		if (!this.port) this.connect();
		return new Promise((resolve, reject) => {
			const port = this.port;
			if (!port) {
				reject(new BridgeFailure('internal', 'the Gloss bridge is not available'));
				return;
			}
			const id = String(this.nextId++);
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BridgeFailure('internal', `${method} timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			try {
				port.postMessage({ id, method, params });
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new BridgeFailure('internal', e instanceof Error ? e.message : String(e)));
			}
		});
	}

	onEvent(handler: (event: string, data: unknown) => void): () => void {
		return this.emitter.onEvent(handler);
	}

	onStateChange(handler: (state: TransportState, detail?: string) => void): () => void {
		return this.emitter.onStateChange(handler);
	}

	private onMessage(msg: BridgeIncoming): void {
		if ('event' in msg) {
			this.emitter.emit(msg.event, msg.data);
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		if ('error' in msg) p.reject(new BridgeFailure(msg.error.code, msg.error.message));
		else p.resolve(msg.result);
	}

	private onDisconnect(detail?: string): void {
		this.port = null;
		const failure = new BridgeFailure('internal', detail ?? 'the Gloss bridge disconnected');
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(failure);
		}
		this.pending.clear();
		this.setState('disconnected', detail);
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, this.backoff);
		this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
	}

	private setState(state: TransportState, detail?: string): void {
		this.state = state;
		this.emitter.emitState(state, detail);
	}
}
